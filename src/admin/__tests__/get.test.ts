import { describe, expect, test } from 'bun:test';
import { GET_FIELDS, buildGetResponse } from '../get.ts';
import { RuntimeConfigStore } from '../runtime-store.ts';
import { DebugController } from '../../debug.ts';
import { FakeDownloaderStore } from '../../downloader/__tests__/fakes.ts';
import type { Config, Role } from '../../config/schema.ts';

const config: Config = {
	global: {
		roles: 'SUBSCRIBER,DOWNLOADER',
		worker: 'downloader1',
		queue: 'wis2gc',
		redis: { mode: 'single', nodes: ['localhost:6379'] },
		log: { level: 'info' },
	},
	subscriber: {
		'global-broker': [{ broker: 'mqtts://example.com' }],
		mqtt: { whitelist: ['origin/a/wis2/fr-meteofrance/data/x'], 'global-replay': 'https://replay.example.com' },
	},
};

function ctx(roles: Role[] = ['SUBSCRIBER', 'DOWNLOADER'], credentialsStore = new FakeDownloaderStore(), debug = new DebugController()) {
	const store = new RuntimeConfigStore(config);
	return {
		activeRoles: new Set<Role>(roles),
		ctx: { config, store, credentialsStore, debug, warn: () => {} },
		store,
		credentialsStore,
		debug,
	};
}

describe('buildGetResponse', () => {
	test('no key: returns every field the active roles are allowed to see', async () => {
		const { activeRoles, ctx: c } = ctx(['SUBSCRIBER']);
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c);
		expect(result.status).toBe(200);
		expect(result.body['process-mode']).toBe('run');
		expect(result.body.whitelist).toEqual(['origin/a/wis2/fr-meteofrance/data/x']);
		// DOWNLOADER-only field absent for a SUBSCRIBER-only replica.
		expect(result.body.credentials).toBeUndefined();
	});

	test('?key=whitelist: 403 when SUBSCRIBER is not active', async () => {
		const { activeRoles, ctx: c } = ctx(['DOWNLOADER']);
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c, 'whitelist');
		expect(result.status).toBe(403);
	});

	test('?key=bogus: 400 unknown key', async () => {
		const { activeRoles, ctx: c } = ctx();
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c, 'bogus');
		expect(result.status).toBe(400);
	});

	test('?key=credentials: reads back from the credentials store, parsed', async () => {
		const credentialsStore = new FakeDownloaderStore();
		await credentialsStore.setCredential('origin/a/wis2/us-noaa/data/recommended', { username: 'u', password: 'p' });
		const { activeRoles, ctx: c } = ctx(['DOWNLOADER'], credentialsStore);
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c, 'credentials');
		expect(result.status).toBe(200);
		expect(result.body.credentials).toEqual({ 'origin/a/wis2/us-noaa/data/recommended': { username: 'u', password: 'p' } });
	});

	test('log-level-role: reflects a store override (new addition, not in flows.json)', async () => {
		const { activeRoles, ctx: c, store } = ctx();
		store.applyPatch({ 'log-level-role': { role: 'SUBSCRIBER', value: 'debug' } });
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c, 'log-level-role');
		expect(result.body['log-level-role']).toEqual({ SUBSCRIBER: 'debug' });
	});

	test('debug: empty by default, reflects whatever was set dynamically -- not the static CLI baseline', async () => {
		const { activeRoles, ctx: c, debug } = ctx();
		expect((await buildGetResponse(GET_FIELDS, activeRoles, c, 'debug')).body.debug).toEqual([]);
		debug.setDynamic(['SUBSCRIBER']);
		const result = await buildGetResponse(GET_FIELDS, activeRoles, c, 'debug');
		expect(result.body.debug).toEqual(['SUBSCRIBER']);
	});
});
