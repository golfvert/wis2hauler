// Real MqttLike, backed by mqtt.js. One connection per BrokerConfig —
// used for each of Subscriber's GB1/GB2 upstream brokers, and for
// each of global.local-broker's PUB1/PUB2 targets that publish-only
// outcomes republish onto.
import mqtt, { MqttClient, type IClientOptions } from 'mqtt';
// mqtt.js's own "runs in a real browser" stream builder -- see
// buildMqttClient's header comment for why this port needs it too.
// A named export (unlike its tcp.js/tls.js siblings' bare `export
// default`), and confirmed (2026-09-13) to resolve to the same callable
// function under both `bun run` and a `bun build --compile` binary --
// tcp.js/tls.js's default exports do NOT (they come back double-wrapped
// in an extra `{ default: fn }` layer under --compile only), which is
// exactly why this fix reaches for ONLY this one named export and
// leaves mqtt.connect()'s own tcp/tls dispatch alone entirely (see
// below) rather than also hand-selecting those two.
import { browserStreamBuilder } from 'mqtt/lib/connect/ws';
import type { BrokerConfig } from '../config/schema.ts';
import type { MqttLike } from './types.ts';

function wrapMqttClient(client: MqttClient): MqttLike {
	return {
		subscribe(topics) {
			return new Promise((res, rej) => {
				client.subscribe([...topics], { qos: 1 }, (err) => (err ? rej(err) : res()));
			});
		},
		onMessage(handler) {
			client.on('message', (topic, payload) => handler(topic, payload));
		},
		publish(topic, payload) {
			// Fail fast instead of hanging: mqtt.js queues a QoS>0
			// publish while offline and only invokes its callback once
			// the message is actually sent and acked -- for a
			// connectMqttBestEffort client (below) whose broker may
			// simply never come back, that callback could otherwise
			// never fire. Rejecting immediately when not currently
			// connected means "can't connect" and "was connected, then
			// dropped" are handled identically: callers (subscriber/
			// consumer.ts's publish-only case, downloader/finishing.ts)
			// already catch and log-and-continue per message/job, so
			// this turns a possible silent stall into that same bounded,
			// already-handled error path.
			if (!client.connected) {
				return Promise.reject(new Error(`mqtt client not connected (cannot publish to ${topic})`));
			}
			return new Promise((res, rej) => {
				client.publish(topic, payload, { qos: 1 }, (err) => (err ? rej(err) : res()));
			});
		},
		end() {
			// force:true (not false) -- mqtt.js's own well-documented
			// gotcha: end(false, ...)'s callback waits for a graceful
			// MQTT DISCONNECT over a live connection, but if the
			// client happens to be mid-reconnect/backoff (reconnectPeriod
			// above) when shutdown is requested, there's no live
			// connection to gracefully close over and the callback can
			// simply never fire -- observed live (the maintainer: SIGINT/Ctrl-C
			// does nothing, only kill -9 works) since main.ts's shutdown
			// path awaits every client's end() before the process can
			// exit. force closes the underlying socket immediately
			// regardless of connection state, so this always resolves.
			// It also stops mqtt.js's own reconnect loop, so a
			// connectMqttBestEffort client that's mid-retry in the
			// background stops cleanly too.
			return new Promise((res) => client.end(true, {}, () => res()));
		},
	};
}

// BUN COMPATIBILITY, 2026-09-13 (real deployment failure, worker "one":
// `Error: Not supported yet in Bun` at `createWebSocketStream (ws:...)`,
// thrown the moment its wss://scgc.teganet.eu local-broker connection
// tried to open under the compiled Bun binary -- every one of these
// workers' `PUB1` connections crash-loops main.ts's startup forever):
//
// Bun ships its own built-in, NOT feature-complete reimplementation of
// the `ws` npm package, silently substituted in whenever anything
// imports/requires "ws" -- confirmed a real, still-open, still-unfixed
// Bun limitation (oven-sh/bun#4568; a fix, oven-sh/bun#35459, has been
// proposed but is still an open, unmerged PR as of 2026-09-13 -- its own
// description names mqtt.js by name as one of the packages this
// breaks). Bun's substitute `ws` doesn't implement
// `createWebSocketStream` at all -- it just throws that literal
// message. mqtt.js's Node-mode stream builder (mqtt/lib/connect/ws.js's
// `streamBuilder`, the one mqtt.connect() picks for every ws/wss broker
// whenever `is_browser_1.default` is false, which it always is here)
// calls exactly that function.
//
// mqtt.js already has a second, WORKING code path for this scenario:
// `browserStreamBuilder` (same file) -- what every real web browser
// uses instead, built entirely on the standard global `WebSocket`
// (which Bun DOES fully, natively implement -- this is Bun's own
// spec-compliant client, not a shim of anyone else's package) plus the
// `readable-stream` npm package (a pure-JS userland stream
// reimplementation, unaffected by any of this). mqtt.connect() itself
// picks between the two builders via `is_browser || opts.forceNativeWebSocket`
// -- but that choice is cached in a MODULE-LEVEL variable the FIRST
// time mqtt.connect() is called ANYWHERE in this process, for every
// later call, regardless of that later call's own opts (mqtt/lib/
// connect/index.js's `let protocols = null; if (!protocols) {...}`).
// This process runs BOTH wss:// local-broker connections AND real
// mqtts:// (plain TLS, not WebSocket at all) global-broker connections
// side by side -- see the maintainer's real worker "one" config:
// local-broker wss://scgc.teganet.eu + global-broker
// mqtts://globalbroker.meteo.fr. Simply passing `forceNativeWebSocket:
// true` on every mqtt.connect() call would have silently broken THOSE
// mqtts:// connections instead: mqtt.connect()'s browser-mode protocol
// table has no 'mqtts' handler at all, and its own fallback
// protocol-matching logic would silently reroute a "mqtts" request onto
// 'wss' instead -- the wrong transport entirely, and not an error
// anyone would notice until messages simply never arrived.
//
// Fix: bypass mqtt.connect()'s protocol dispatch/module-level cache
// entirely, but ONLY for ws/wss brokers -- construct the `MqttClient`
// directly with `browserStreamBuilder`. This never touches, and is
// never affected by, whatever mqtt.connect() itself later decides for
// some OTHER (tcp/tls) broker in the same process. Plain mqtt://mqtts://
// brokers are untouched below -- they still go through ordinary
// mqtt.connect(), exactly as before this fix, since that path never
// touches the `ws` package at all and was never broken.
function isWebSocketBroker(brokerUrl: string): boolean {
	const protocol = new URL(brokerUrl).protocol.replace(/:$/, '');
	return protocol === 'ws' || protocol === 'wss';
}

/** `browserStreamBuilder`'s own URL builder wants protocol/hostname/port/path pre-parsed onto opts -- mirrors exactly what mqtt.connect()'s string-URL parsing does today, just without also deciding (and caching) which builder every OTHER broker in this process gets. */
function parseWebSocketBrokerUrl(brokerUrl: string): Pick<IClientOptions, 'protocol' | 'hostname' | 'port' | 'path'> {
	const parsed = new URL(brokerUrl);
	const protocol = parsed.protocol.replace(/:$/, '') as 'ws' | 'wss';
	return {
		protocol,
		hostname: parsed.hostname,
		port: parsed.port ? Number(parsed.port) : undefined,
		path: `${parsed.pathname}${parsed.search}` || '/',
	};
}

/**
 * Builds (but does not wait on) the MqttClient for one BrokerConfig,
 * choosing the right transport per-connection instead of relying on
 * mqtt.connect()'s process-wide cached choice -- see this file's
 * BUN COMPATIBILITY comment above. `extraOpts` carries whatever the two
 * exported connect functions below don't share (currently just
 * connectMqttBestEffort's `connectTimeout`).
 */
function buildMqttClient(broker: BrokerConfig, clientId: string, extraOpts: Pick<IClientOptions, 'connectTimeout'>): MqttClient {
	const rejectUnauthorized = broker.verifycert ?? true;
	const baseOpts: IClientOptions = {
		username: broker.username,
		password: broker.password,
		protocolVersion: broker.version ?? 5,
		rejectUnauthorized,
		clientId,
		reconnectPeriod: 5000,
		...extraOpts,
	};

	if (!isWebSocketBroker(broker.broker)) {
		return mqtt.connect(broker.broker, baseOpts);
	}

	const wsOpts: IClientOptions = {
		...baseOpts,
		...parseWebSocketBrokerUrl(broker.broker),
		// browserStreamBuilder's default `new WebSocket(url, [subprotocol])`
		// call (mqtt/lib/connect/ws.js's createBrowserWebSocket) never passes
		// wsOptions/rejectUnauthorized through to the socket at all -- this
		// hook is the only way to actually honor broker.verifycert (default
		// true, i.e. normal TLS validation) on this path. Bun's native
		// WebSocket accepts a `tls` option shaped exactly like node:tls's,
		// the same as `fetch`.
		createWebsocket: (url, protocols) => new WebSocket(url, { protocols, tls: { rejectUnauthorized } }),
	};
	// MqttClient.connect() calls `this.streamBuilder(this)` with ONE
	// argument -- opts is never passed at the call site, matching
	// mqtt.connect()'s own `function wrapper(client) { ... return
	// protocols[opts.protocol](client, opts); }` (mqtt/lib/connect/
	// index.js): every real streamBuilder needs `opts` closed over by
	// whatever function is actually handed to `new MqttClient(...)`,
	// not read off the call. Same pattern here, just closing over
	// `wsOpts` instead of mqtt.connect()'s own cached-per-process `opts`.
	return new MqttClient((client) => browserStreamBuilder(client, wsOpts), wsOpts);
}

// GB1/GB2 (Subscriber's actual upstream data source) -- blocking until
// connected is the right behavior here: there is nothing useful for
// Subscriber to do without it, so it retries forever (reconnectPeriod)
// and the caller awaits that.
//
// `label` is a role tag for log lines only (e.g. "GB1", "PUB2") --
// see connectMqttBestEffort's logOutageOnce below. `clientId` is the
// actual MQTT client id put on the wire; per the maintainer's request ("use the
// centre-id - worker name"), the caller (main.ts -- see its
// DELIBERATE CHANGE, 2026-09-12 comment) builds it from
// `${centre-id}-${worker}`, plus this connection's own `label`
// appended for uniqueness. That suffix isn't optional: a replica can
// run SUBSCRIBER with two GB brokers (GB1/GB2), and PUB1/PUB2 is
// shared with DOWNLOADER when both are active on the SAME replica --
// `centre-id-worker` alone would hand two simultaneous connections to
// the same broker the identical client id -- the MQTT spec has the
// broker disconnect whichever connection held that id first, so the
// two connections would fight each other in an endless kick/reconnect
// loop. Keeping `label` in the id (GB1 vs GB2, PUB1 vs PUB2) keeps
// every connection this process opens unique per broker. main.ts is
// now the ONLY caller of connectMqtt/connectMqttBestEffort -- it owns
// every MQTT connection this process makes, opening PUB1/PUB2 once
// and handing the same client instances to whichever of SUBSCRIBER/
// DOWNLOADER are active, rather than each role dialing its own (see
// main.ts's RoleRunners doc comment).
export function connectMqtt(broker: BrokerConfig, label: string, clientId: string): Promise<MqttLike> {
	return new Promise((resolve, reject) => {
		const client = buildMqttClient(broker, clientId, {});

		client.once('connect', () => resolve(wrapMqttClient(client)));
		client.once('error', (err) => reject(err));
	});
}

// PUB1/PUB2 (global.local-broker) -- these are publish-only outcome
// sinks (cache/monitor topic republish, cleaner-report notifications),
// not required for the subscribe/download loop itself to run. Used by
// both DOWNLOADER and SUBSCRIBER's run.ts. Unlike connectMqtt above,
// this must NEVER block its caller indefinitely, whether the broker
// can't be reached at all yet, or was reachable and then dropped --
// observed live (the maintainer, 2026-09-10): an unreachable local-broker
// hostname (a Docker Compose service name not resolvable from a
// natively-run process, the same class of issue as the aria-url fix)
// left DOWNLOADER/SUBSCRIBER stuck forever at "connecting to PUB1",
// never reaching the actual consumer loop, so nothing ever got
// downloaded and nothing was ever logged.
//
// Design: this always resolves with a usable MqttLike, within
// `initialTimeoutMs` (bounded by mqtt.js's own connectTimeout and our
// own setTimeout as a hard backstop regardless of what stage the
// underlying connection is stuck at, e.g. a hung DNS lookup) -- never
// with null, never left hanging. If the broker isn't up yet, that's
// logged once and the caller proceeds with a client that currently
// can't publish (see wrapMqttClient's publish() guard above, which
// fails fast rather than queuing forever). reconnectPeriod stays at
// the normal 5000ms *after* the initial wait, so mqtt.js keeps
// retrying in the background indefinitely -- no code here has to poll
// or retry anything itself, and publish() simply starts working again
// on its own once the broker becomes reachable (client.connected flips
// back to true). Each new outage (first failure, or a later drop) logs
// exactly one error, not one per 5s retry attempt.
const DEFAULT_LOCAL_BROKER_CONNECT_TIMEOUT_MS = 5000;

export function connectMqttBestEffort(
	broker: BrokerConfig,
	label: string,
	clientId: string,
	log: Pick<typeof console, 'error'>,
	initialTimeoutMs: number = DEFAULT_LOCAL_BROKER_CONNECT_TIMEOUT_MS,
): Promise<MqttLike> {
	return new Promise((resolve) => {
		let settledInitial = false;
		let loggedCurrentOutage = false;

		const client = buildMqttClient(broker, clientId, { connectTimeout: initialTimeoutMs });

		const wrapper = wrapMqttClient(client);

		const finishInitialWait = () => {
			if (settledInitial) return;
			settledInitial = true;
			clearTimeout(timer);
			resolve(wrapper);
		};

		const logOutageOnce = (reason: string) => {
			if (loggedCurrentOutage) return;
			loggedCurrentOutage = true;
			log.error(`local-broker ${label} (${broker.broker}) unreachable, continuing without it (will keep retrying in the background): ${reason}`);
		};

		const timer = setTimeout(() => {
			logOutageOnce(`no response within ${initialTimeoutMs}ms`);
			finishInitialWait();
		}, initialTimeoutMs);

		client.on('connect', () => {
			loggedCurrentOutage = false; // recovered -- the next drop gets its own log line
			finishInitialWait();
		});
		client.on('error', (err) => {
			logOutageOnce(err instanceof Error ? err.message : String(err));
			finishInitialWait();
		});
	});
}
