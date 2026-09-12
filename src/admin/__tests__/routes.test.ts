import { describe, expect, test } from 'bun:test';
import { registerAdminRoutes, type AdminRouteDeps } from '../routes.ts';
import { RuntimeConfigStore } from '../runtime-store.ts';
import { DebugController } from '../../debug.ts';
import { FakeDownloaderStore } from '../../downloader/__tests__/fakes.ts';
import type { Config, Role } from '../../config/schema.ts';
import type { HttpHandler, HttpRouter } from '../../http/router.ts';
import type { SourceLogger } from '../../logging/logger.ts';

const config: Config = {
	global: {
		roles: 'SUBSCRIBER,DOWNLOADER',
		worker: 'downloader1',
		redis: { mode: 'single', nodes: ['localhost:6379'] },
		log: { level: 'info' },
	},
	subscriber: {
		'global-broker': [{ broker: 'mqtts://example.com' }],
		mqtt: { whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] },
	},
};

// A fake HttpRouter that just records registered handlers by "METHOD
// path" so a test can invoke one directly, without actually binding a
// port via createHttpServer (see ../../http/router.ts).
function fakeRouter(): { router: HttpRouter; handlers: Map<string, HttpHandler> } {
	const handlers = new Map<string, HttpHandler>();
	const router: HttpRouter = {
		get: (path, handler) => handlers.set(`GET ${path}`, handler),
		post: (path, handler) => handlers.set(`POST ${path}`, handler),
	};
	return { router, handlers };
}

function fakeSourceLogger(): { logger: SourceLogger; infoCalls: Record<string, unknown>[] } {
	const infoCalls: Record<string, unknown>[] = [];
	return { logger: { info: (d) => infoCalls.push(d), warn: () => {}, debug: () => {} }, infoCalls };
}

function setup(overrides: Partial<AdminRouteDeps> = {}) {
	const { router, handlers } = fakeRouter();
	const store = new RuntimeConfigStore(config);
	const credentialsStore = new FakeDownloaderStore();
	const debug = new DebugController();
	const activeRoles = new Set<Role>(['SUBSCRIBER', 'DOWNLOADER']);
	const deps: AdminRouteDeps = { config, store, activeRoles, credentialsStore, debug, log: { ...console, warn: () => {} }, ...overrides };
	registerAdminRoutes(router, deps);
	return { handlers, store, debug };
}

function postSet(handlers: Map<string, HttpHandler>, body: unknown): Promise<Response> {
	const handler = handlers.get('POST /set');
	if (!handler) throw new Error('POST /set not registered');
	return Promise.resolve(handler(new Request('http://localhost/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
}

function getReq(handlers: Map<string, HttpHandler>, query = ''): Promise<Response> {
	const handler = handlers.get('GET /get');
	if (!handler) throw new Error('GET /get not registered');
	return Promise.resolve(handler(new Request(`http://localhost/get${query}`)));
}

describe('registerAdminRoutes: POST /set "Change ?" logging', () => {
	test('a key whose value actually changed logs one Info call with the key and new value', async () => {
		const { logger, infoCalls } = fakeSourceLogger();
		const { handlers } = setup({ changeLogger: logger });

		await postSet(handlers, { 'log-level': 'debug' });

		expect(infoCalls).toEqual([{ key: 'log-level', value: 'debug' }]);
	});

	test('a key patched to its already-current value (changed: false) does not log', async () => {
		const { logger, infoCalls } = fakeSourceLogger();
		const { handlers } = setup({ changeLogger: logger });

		// The store's log-level already defaults to "info" (see config.global.log.level above).
		await postSet(handlers, { 'log-level': 'info' });

		expect(infoCalls).toHaveLength(0);
	});

	test('a patch touching multiple keys logs once per actually-changed key', async () => {
		const { logger, infoCalls } = fakeSourceLogger();
		const { handlers } = setup({ changeLogger: logger });

		await postSet(handlers, { 'log-level': 'debug', whitelist: ['origin/a/wis2/fr-meteofrance/data/y'] });

		expect(infoCalls).toHaveLength(2);
		expect(infoCalls).toContainEqual({ key: 'log-level', value: 'debug' });
		expect(infoCalls.some((c) => c.key === 'whitelist')).toBe(true);
	});

	test('no changeLogger configured: /set still works (the log call is simply skipped)', async () => {
		const { handlers } = setup();
		const res = await postSet(handlers, { 'log-level': 'debug' });
		expect(res.status).toBe(200);
	});
});

describe('registerAdminRoutes: GET /get + POST /set wire the shared DebugController end-to-end', () => {
	test('POST /set {debug:[...]} is visible immediately via GET /get?key=debug, and on the DebugController itself', async () => {
		const { handlers, debug } = setup();

		const setRes = await postSet(handlers, { debug: ['SUBSCRIBER'] });
		expect(setRes.status).toBe(200);
		expect(debug.has('SUBSCRIBER')).toBe(true);

		const getRes = await getReq(handlers, '?key=debug');
		const body = (await getRes.json()) as { debug: string[] };
		expect(body.debug).toEqual(['SUBSCRIBER']);
	});
});
