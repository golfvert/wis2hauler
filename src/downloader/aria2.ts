// A single real WebSocket JSON-RPC-over-WS client to aria2, replacing the
// original's THREE separate Node-RED "dynamic-websocket" custom-node
// connections (Downloader tab: "Download" id 4e84f9dffc97517c, and two
// identically-configured "Status" nodes id ac8ba5f33c4a4f6b /
// 506e99efd94c4764 -- one dedicated to tellStatus calls made after an
// onDownloadComplete notification, the other after onDownloadError). Per
// the maintainer's explicit decision (this phase's first AskUserQuestion), the Bun
// port collapses these to ONE real WebSocket connection and correlates
// every request/response pair by the JSON-RPC "id" field, since the
// custom node's own wire contract isn't fully specified by flows.json's
// static JSON -- the literal 3-connection structure was Node-RED
// flow-organization, not a functional requirement: "Connect"
// (42b1ccacba64b751) broadcasts a single URL change to all three node
// instances at once on every reconnect, i.e. they were always meant to be
// the same logical connection to the same aria2 endpoint.
//
// FACTS PULLED DIRECTLY FROM flows.json (not inferred):
//   - Every outgoing request wraps its `token:<secret>` auth as the FIRST
//     element of the JSON-RPC "params" array (never a URL/header auth) --
//     see the "Aria" change node's addUri build (Setup tab feeds
//     aria-secret; Downloader tab's "Aria" node consumes it) and the
//     "Gid" change nodes' tellStatus build.
//   - addUri's params: [ "token:"+secret, [href], merge({out, disk-cache:0,
//     check-certificate}, credsForTopic) ] -- check-certificate is DROPPED
//     entirely when undefined (JSONata $merge semantics), not sent as
//     null; matches schema.ts's 'aria-check-tls' being Optional.
//   - Incoming messages are told apart exactly like the "Back" switch
//     (a6ca42c9f3a02fc7) does: $contains(payload.method,"Complete") ->
//     onDownloadComplete notification; $contains(payload.method,"Error")
//     -> onDownloadError notification; $type(payload.result)="string" ->
//     a response to our own addUri call (result is the gid string). aria2
//     notifications carry "method"/"params" and no "id"; responses to our
//     calls always carry the "id" we sent -- that split (method present +
//     no id => notification) is what this client uses to route incoming
//     frames, rather than hard-coding "Complete"/"Error" substring checks.
//   - tellStatus params: ["token:"+secret, gid] (see the "Gid" change
//     nodes); the original hardcodes id:"1" for every tellStatus call
//     because each of its two dedicated Status connections only ever has
//     one call in flight at a time. Since this port multiplexes every
//     request over ONE connection, every request (addUri AND tellStatus
//     alike) gets a real per-call unique id instead -- that's what makes
//     response correlation on a shared connection possible at all. This
//     is a deliberate, necessary consequence of the single-connection
//     design the maintainer chose, not a guess.
//   - Reconnect cadence: the "Retry" inject node fires every 5s and
//     reconnects only when flow.aria2_connected === false (the
//     "Connected ?" switch, 913464af7a3946b5) -- ported as a 5s
//     reconnect-check interval. "autoReconnect" is explicitly false on
//     all three dynamic-websocket node configs -- the 5s poll IS the
//     original's only reconnect mechanism, there is no lower-level
//     auto-reconnect being skipped here.
//   - A per-call response timeout is NOT something the original's opaque
//     custom node specifies anywhere in flows.json -- it's an addition
//     required so a shared connection's pending-request map can't leak
//     forever if aria2 never answers. Flagged in Aria2ClientOptions below,
//     not silently invented.

export interface Aria2AddUriOptions {
	filename: string;
	checkCertificate?: boolean;
	credentials?: { username: string; password: string };
}

export interface Aria2StatusFile {
	path: string;
}

export interface Aria2Status {
	status: string;
	files: Aria2StatusFile[];
	[key: string]: unknown;
}

/** A pushed aria2 notification (onDownloadComplete / onDownloadError / ...), gid extracted from params[0].gid. */
export interface Aria2Notification {
	method: string;
	gid: string;
}

export interface WebSocketLike {
	readyState: number;
	send(data: string): void;
	close(): void;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((err: unknown) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const WS_OPEN = 1;

export interface Aria2ClientOptions {
	url: string;
	secret: string;
	createWebSocket: WebSocketFactory;
	/** How often (ms) to check the connection and retry if it's down. Defaults to 5000 -- the original's "Retry" inject cadence. */
	reconnectIntervalMs?: number;
	/** How long (ms) to wait for a JSON-RPC response before rejecting. See the file-level note: not part of the literal port, an addition this design needs. Defaults to 30000. */
	requestTimeoutMs?: number;
	onConnect?: () => void;
	onDisconnect?: () => void;
	onNotification?: (notification: Aria2Notification) => void;
	/** Non-fatal transport/parse problems: a message that wasn't valid JSON, a response for an id we don't recognize, a notification with no params[0].gid. */
	onWarning?: (message: string) => void;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(err: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

export class Aria2Client {
	private readonly url: string;
	private readonly secret: string;
	private readonly createWebSocket: WebSocketFactory;
	private readonly reconnectIntervalMs: number;
	private readonly requestTimeoutMs: number;
	private readonly onConnectCb?: () => void;
	private readonly onDisconnectCb?: () => void;
	private readonly onNotificationCb?: (notification: Aria2Notification) => void;
	private readonly onWarningCb?: (message: string) => void;

	private socket: WebSocketLike | null = null;
	private connected = false;
	private nextId = 1;
	private readonly pending = new Map<string, PendingRequest>();
	private reconnectTimer: ReturnType<typeof setInterval> | null = null;
	private closed = false;

	constructor(options: Aria2ClientOptions) {
		this.url = options.url;
		this.secret = options.secret;
		this.createWebSocket = options.createWebSocket;
		this.reconnectIntervalMs = options.reconnectIntervalMs ?? 5000;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
		this.onConnectCb = options.onConnect;
		this.onDisconnectCb = options.onDisconnect;
		this.onNotificationCb = options.onNotification;
		this.onWarningCb = options.onWarning;
	}

	isConnected(): boolean {
		return this.connected;
	}

	/** Opens the connection and starts the 5s reconnect-check loop -- the original's gated first connect plus the "Retry" inject's 5s poll collapse into one loop here since there's only one connection to manage. */
	start(): void {
		this.closed = false;
		this.connectOnce();
		if (this.reconnectTimer === null) {
			this.reconnectTimer = setInterval(() => {
				if (!this.connected && !this.closed) {
					this.connectOnce();
				}
			}, this.reconnectIntervalMs);
		}
	}

	stop(): void {
		this.closed = true;
		if (this.reconnectTimer !== null) {
			clearInterval(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.socket?.close();
		this.socket = null;
		this.connected = false;
		this.failAllPending(new Error('aria2 client stopped'));
	}

	private connectOnce(): void {
		const socket = this.createWebSocket(this.url);
		this.socket = socket;
		socket.onopen = () => {
			this.connected = true;
			this.onConnectCb?.();
		};
		socket.onclose = () => {
			this.connected = false;
			this.onDisconnectCb?.();
			this.failAllPending(new Error('aria2 connection closed'));
		};
		socket.onerror = (err) => {
			this.onWarningCb?.(`aria2 websocket error: ${err instanceof Error ? err.message : String(err)}`);
		};
		socket.onmessage = (event) => {
			this.handleMessage(event.data);
		};
	}

	private failAllPending(err: Error): void {
		for (const req of this.pending.values()) {
			clearTimeout(req.timer);
			req.reject(err);
		}
		this.pending.clear();
	}

	private handleMessage(raw: string): void {
		let payload: any;
		try {
			payload = JSON.parse(raw);
		} catch {
			this.onWarningCb?.(`aria2 sent a non-JSON message: ${raw}`);
			return;
		}

		// Matches the "Back" switch: a notification carries "method" and no
		// "id"; a response to one of our own calls always carries the "id"
		// we sent, with "result" (success) or "error" (failure).
		if (typeof payload?.method === 'string' && payload.id === undefined) {
			const gid = payload.params?.[0]?.gid;
			if (typeof gid === 'string') {
				this.onNotificationCb?.({ method: payload.method, gid });
			} else {
				this.onWarningCb?.(`aria2 notification "${payload.method}" had no params[0].gid`);
			}
			return;
		}

		const id = payload?.id !== undefined ? String(payload.id) : undefined;
		const pending = id !== undefined ? this.pending.get(id) : undefined;
		if (!pending) {
			this.onWarningCb?.(`aria2 response for an unrecognized id: ${raw}`);
			return;
		}
		this.pending.delete(id!);
		clearTimeout(pending.timer);
		if (payload.error) {
			pending.reject(new Error(`aria2 error ${payload.error.code ?? ''}: ${payload.error.message ?? JSON.stringify(payload.error)}`));
		} else {
			pending.resolve(payload.result);
		}
	}

	private call<T>(method: string, params: unknown[]): Promise<T> {
		if (!this.socket || this.socket.readyState !== WS_OPEN) {
			return Promise.reject(new Error('aria2 is not connected'));
		}
		const id = String(this.nextId++);
		const request = { jsonrpc: '2.0', method, id, params };
		const socket = this.socket;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`aria2 request "${method}" timed out waiting for a response`));
			}, this.requestTimeoutMs);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			socket.send(JSON.stringify(request));
		});
	}

	/** Ported from the "Aria" change node's addUri params build. Resolves to the gid aria2 assigns. */
	addUri(href: string, options: Aria2AddUriOptions): Promise<string> {
		const fileOptions: Record<string, unknown> = {
			out: options.filename,
			'disk-cache': 0,
		};
		if (options.checkCertificate !== undefined) {
			fileOptions['check-certificate'] = options.checkCertificate;
		}
		if (options.credentials) {
			fileOptions['http-user'] = options.credentials.username;
			fileOptions['http-passwd'] = options.credentials.password;
		}
		return this.call<string>('aria2.addUri', [`token:${this.secret}`, [href], fileOptions]);
	}

	/** Ported from the "Gid" change nodes' tellStatus params build. */
	tellStatus(gid: string): Promise<Aria2Status> {
		return this.call<Aria2Status>('aria2.tellStatus', [`token:${this.secret}`, gid]);
	}
}
