import { describe, expect, test } from 'bun:test';
import { Aria2Client, LOWEST_SPEED_LIMIT_BYTES_PER_SEC, type WebSocketLike } from '../aria2';

class FakeSocket implements WebSocketLike {
	readyState = 0;
	sent: string[] = [];
	closeCalls = 0;
	onopen: (() => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: ((err: unknown) => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;

	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closeCalls++;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	receive(obj: unknown) {
		this.onmessage?.({ data: JSON.stringify(obj) });
	}
	receiveRaw(data: string) {
		this.onmessage?.({ data });
	}
	simulateServerClose() {
		this.readyState = 3;
		this.onclose?.();
	}
}

function lastRequest(socket: FakeSocket): any {
	return JSON.parse(socket.sent[socket.sent.length - 1]!);
}

describe('Aria2Client', () => {
	test('addUri sends the exact JSON-RPC shape ported from the "Aria" change node, resolving to the gid on response', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://aria2.local:6800/jsonrpc',
			secret: 's3cr3t',
			createWebSocket: (url) => {
				socket = new FakeSocket();
				expect(url).toBe('ws://aria2.local:6800/jsonrpc');
				return socket;
			},
		});
		client.start();
		socket.open();

		const promise = client.addUri('https://example.test/file.grib', { filename: 'w1_file.grib' });
		const req = lastRequest(socket);
		expect(req.jsonrpc).toBe('2.0');
		expect(req.method).toBe('aria2.addUri');
		expect(typeof req.id).toBe('string');
		expect(req.params).toEqual(['token:s3cr3t', ['https://example.test/file.grib'], { out: 'w1_file.grib', 'disk-cache': 0, 'lowest-speed-limit': 1000 }]);

		socket.receive({ jsonrpc: '2.0', id: req.id, result: 'abc123gid' });
		await expect(promise).resolves.toBe('abc123gid');
		client.stop();
	});

	test('addUri omits check-certificate entirely when undefined, but includes it when set', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();

		client.addUri('https://example.test/a', { filename: 'a', checkCertificate: false }).catch(() => {});
		expect(lastRequest(socket).params[2]).toEqual({ out: 'a', 'disk-cache': 0, 'lowest-speed-limit': 1000, 'check-certificate': false });
		client.stop();
	});

	// 2026-09-22 -- see LOWEST_SPEED_LIMIT_BYTES_PER_SEC's own doc comment
	// (aria2.ts) for the live investigation this backs. Unconditional
	// (unlike check-certificate/credentials above): every addUri call
	// gets a stall floor, not just ones that opt in.
	test('addUri always sends lowest-speed-limit -- the per-download stall floor', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();

		client.addUri('https://example.test/a', { filename: 'a' }).catch(() => {});
		expect(lastRequest(socket).params[2]).toMatchObject({ 'lowest-speed-limit': LOWEST_SPEED_LIMIT_BYTES_PER_SEC });
		expect(LOWEST_SPEED_LIMIT_BYTES_PER_SEC).toBe(1000);
		client.stop();
	});

	test('addUri includes http-user/http-passwd only when credentials are supplied', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();

		client
			.addUri('https://example.test/a', {
				filename: 'a',
				credentials: { username: 'u', password: 'p' },
			})
			.catch(() => {});
		expect(lastRequest(socket).params[2]).toEqual({
			out: 'a',
			'disk-cache': 0,
			'lowest-speed-limit': 1000,
			'http-user': 'u',
			'http-passwd': 'p',
		});
		client.stop();
	});

	test('tellStatus sends the exact params ported from the "Gid" change nodes, resolves to the status object', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 'tok',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();

		const promise = client.tellStatus('gid-1');
		const req = lastRequest(socket);
		expect(req.method).toBe('aria2.tellStatus');
		expect(req.params).toEqual(['token:tok', 'gid-1']);

		socket.receive({ jsonrpc: '2.0', id: req.id, result: { status: 'complete', files: [{ path: '/downloads/x' }] } });
		await expect(promise).resolves.toEqual({ status: 'complete', files: [{ path: '/downloads/x' }] });
		client.stop();
	});

	test('two concurrent calls get distinct ids and correlate correctly even when answered out of order', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();

		const p1 = client.addUri('https://example.test/1', { filename: 'f1' });
		const p2 = client.addUri('https://example.test/2', { filename: 'f2' });
		const [req1, req2] = socket.sent.map((s) => JSON.parse(s));
		expect(req1.id).not.toBe(req2.id);

		// answer the SECOND request first
		socket.receive({ jsonrpc: '2.0', id: req2.id, result: 'gid-2' });
		socket.receive({ jsonrpc: '2.0', id: req1.id, result: 'gid-1' });

		await expect(p1).resolves.toBe('gid-1');
		await expect(p2).resolves.toBe('gid-2');
		client.stop();
	});

	test('a pushed notification (method present, no id) is routed to onNotification, not treated as a response', async () => {
		let socket!: FakeSocket;
		const notifications: Array<{ method: string; gid: string }> = [];
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			onNotification: (n) => notifications.push(n),
		});
		client.start();
		socket.open();

		socket.receive({ jsonrpc: '2.0', method: 'aria2.onDownloadComplete', params: [{ gid: 'done-gid' }] });
		socket.receive({ jsonrpc: '2.0', method: 'aria2.onDownloadError', params: [{ gid: 'err-gid' }] });

		expect(notifications).toEqual([
			{ method: 'aria2.onDownloadComplete', gid: 'done-gid' },
			{ method: 'aria2.onDownloadError', gid: 'err-gid' },
		]);
		client.stop();
	});

	test('a notification missing params[0].gid warns instead of crashing', async () => {
		let socket!: FakeSocket;
		const warnings: string[] = [];
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			onWarning: (m) => warnings.push(m),
		});
		client.start();
		socket.open();
		socket.receive({ jsonrpc: '2.0', method: 'aria2.onDownloadComplete', params: [] });
		expect(warnings).toHaveLength(1);
		client.stop();
	});

	test('a response for an unrecognized id warns instead of crashing', async () => {
		let socket!: FakeSocket;
		const warnings: string[] = [];
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			onWarning: (m) => warnings.push(m),
		});
		client.start();
		socket.open();
		socket.receive({ jsonrpc: '2.0', id: '999', result: 'x' });
		expect(warnings).toHaveLength(1);
		client.stop();
	});

	test('a non-JSON message warns instead of crashing', async () => {
		let socket!: FakeSocket;
		const warnings: string[] = [];
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			onWarning: (m) => warnings.push(m),
		});
		client.start();
		socket.open();
		socket.receiveRaw('not json{{y');
		expect(warnings).toHaveLength(1);
		client.stop();
	});

	test('a JSON-RPC error response rejects the call with a descriptive error', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start();
		socket.open();
		const promise = client.tellStatus('bad-gid');
		const req = lastRequest(socket);
		socket.receive({ jsonrpc: '2.0', id: req.id, error: { code: 1, message: 'GID not found' } });
		await expect(promise).rejects.toThrow('GID not found');
		client.stop();
	});

	test('calling before the socket is open rejects immediately without sending', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
		});
		client.start(); // socket created but never opened
		await expect(client.tellStatus('g')).rejects.toThrow('not connected');
		expect(socket.sent).toEqual([]);
		client.stop();
	});

	test('onConnect/onDisconnect fire on open/close, isConnected() reflects state, a server close fails pending calls', async () => {
		let socket!: FakeSocket;
		let connects = 0;
		let disconnects = 0;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			onConnect: () => connects++,
			onDisconnect: () => disconnects++,
		});
		client.start();
		expect(client.isConnected()).toBe(false);
		socket.open();
		expect(client.isConnected()).toBe(true);
		expect(connects).toBe(1);

		const promise = client.tellStatus('g');
		socket.simulateServerClose();
		expect(client.isConnected()).toBe(false);
		expect(disconnects).toBe(1);
		await expect(promise).rejects.toThrow('aria2 connection closed');
		client.stop();
	});

	test('a request that never gets a response times out and rejects', async () => {
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => (socket = new FakeSocket()),
			requestTimeoutMs: 10,
		});
		client.start();
		socket.open();
		await expect(client.tellStatus('g')).rejects.toThrow('timed out');
		client.stop();
	});

	test('stop() closes the socket, cancels the reconnect loop, and fails any pending calls', async () => {
		let createCount = 0;
		let socket!: FakeSocket;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => {
				createCount++;
				return (socket = new FakeSocket());
			},
			reconnectIntervalMs: 15,
		});
		client.start();
		socket.open();
		const promise = client.tellStatus('g');
		client.stop();
		expect(socket.closeCalls).toBe(1);
		await expect(promise).rejects.toThrow('aria2 client stopped');

		// the reconnect loop must not fire again after stop()
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(createCount).toBe(1);
	});

	test('start() reconnects on the configured interval while disconnected', async () => {
		let createCount = 0;
		const client = new Aria2Client({
			url: 'ws://x',
			secret: 's',
			createWebSocket: () => {
				createCount++;
				return new FakeSocket(); // never opened -- stays disconnected
			},
			reconnectIntervalMs: 15,
		});
		client.start();
		expect(createCount).toBe(1);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(createCount).toBeGreaterThan(1);
		client.stop();
	});
});
