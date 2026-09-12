import { afterEach, describe, expect, test } from 'bun:test';
import { createHttpServer, type HttpServerHandle } from '../router.ts';

let handle: HttpServerHandle | undefined;

afterEach(() => {
	handle?.stop();
	handle = undefined;
});

describe('createHttpServer', () => {
	test('dispatches GET/POST routes registered by different callers on the same instance', async () => {
		handle = createHttpServer(0); // port 0 -- OS-assigned, avoids clashing with a real port in CI
		handle.router.get('/reporter/primary', () => new Response(null, { status: 200 }));
		handle.router.post('/caddy', () => new Response('OK', { status: 200 }));
		handle.router.get('/replayer/primary', () => new Response(null, { status: 404 }));

		const base = `http://localhost:${handle.port}`;

		const primary = await fetch(`${base}/reporter/primary`);
		expect(primary.status).toBe(200);

		const replayerPrimary = await fetch(`${base}/replayer/primary`);
		expect(replayerPrimary.status).toBe(404);

		const caddy = await fetch(`${base}/caddy`, { method: 'POST', body: '[]' });
		expect(caddy.status).toBe(200);
		expect(await caddy.text()).toBe('OK');
	});

	test('an unregistered path/method returns 404', async () => {
		handle = createHttpServer(0);
		handle.router.get('/known', () => new Response('ok'));

		const base = `http://localhost:${handle.port}`;
		const missing = await fetch(`${base}/unknown`);
		expect(missing.status).toBe(404);

		const wrongMethod = await fetch(`${base}/known`, { method: 'POST' });
		expect(wrongMethod.status).toBe(404);
	});
});
