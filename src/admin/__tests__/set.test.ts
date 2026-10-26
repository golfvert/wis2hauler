import { describe, expect, test } from 'bun:test';
import { buildSetResponse } from '../set.ts';
import { RuntimeConfigStore } from '../runtime-store.ts';
import { FakeDownloaderStore } from '../../downloader/__tests__/fakes.ts';
import type { Config, Role } from '../../config/schema.ts';

const config: Config = {
	global: {
		roles: 'SUBSCRIBER,DOWNLOADER',
		worker: 'downloader1',
		redis: { mode: 'single', nodes: ['localhost:6379'] },
		log: { level: 'info' },
	},
	subscriber: {
		'global-broker': [{ broker: 'mqtts://example.com' }],
		mqtt: { subscribe: ['origin/a/wis2/fr-meteofrance/data/x'] },
	},
};

function setup(roles: Role[] = ['SUBSCRIBER', 'DOWNLOADER']) {
	const store = new RuntimeConfigStore(config);
	const credentialsStore = new FakeDownloaderStore();
	const activeRoles = new Set<Role>(roles);
	return { store, credentialsStore, activeRoles, warn: () => {} };
}

describe('buildSetResponse', () => {
	test('valid patch: 200, changes reflects value + changed', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'debug' }, activeRoles, { store, credentialsStore, warn });
		expect(result.status).toBe(200);
		expect(result.body.changes['log-level']).toEqual({ value: 'debug', changed: true });
		expect(result.body.errors).toBeUndefined();
	});

	test('invalid body (not an object): 400, no changes', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse('nope', activeRoles, { store, credentialsStore, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes).toEqual({});
		expect(result.body.errors).toContain('Body must be a JSON object.');
	});

	test('a patch with only invalid keys: 400, errors surfaced, nothing applied', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'verbose' }, activeRoles, { store, credentialsStore, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes).toEqual({});
		expect(result.body.errors?.some((e) => e.startsWith('log-level:'))).toBe(true);
	});

	test('a mixed patch: valid keys apply and are reported, invalid ones are listed in errors', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'debug', bogus: true }, activeRoles, { store, credentialsStore, warn });
		expect(result.status).toBe(200);
		expect(result.body.changes['log-level']).toEqual({ value: 'debug', changed: true });
		expect(result.body.errors).toContain('bogus: unknown key.');
	});

	test('credentials create: applies a real HSET via the credentials store, reports changed', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' } },
			activeRoles,
			{ store, credentialsStore, warn },
		);
		expect(result.status).toBe(200);
		expect(result.body.changes.credentials).toEqual({ value: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u' }, changed: true });
		expect(await credentialsStore.getCredentials()).toContain('origin/a/wis2/us-noaa/data/recommended');
	});

	test('credentials delete: changed:false when the topic never existed', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse({ credentials: { op: 'delete', topic: 'origin/a/wis2/nope-noaa/data/recommended' } }, activeRoles, { store, credentialsStore, warn });
		expect(result.body.changes.credentials).toEqual({ value: { op: 'delete', topic: 'origin/a/wis2/nope-noaa/data/recommended' }, changed: false });
	});

	test('credentials role-gated: SUBSCRIBER-only replica cannot touch credentials', async () => {
		const { store, credentialsStore, warn } = setup(['SUBSCRIBER']);
		const result = await buildSetResponse(
			{ credentials: { op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' } },
			new Set<Role>(['SUBSCRIBER']),
			{ store, credentialsStore, warn },
		);
		expect(result.status).toBe(400);
		expect(result.body.errors).toContain('credentials: not available for current roles.');
	});

	test('debug key is gone: rejected as unknown, 400, nothing applied', async () => {
		const { store, credentialsStore, activeRoles, warn } = setup();
		const result = await buildSetResponse({ debug: ['subscriber'] }, activeRoles, { store, credentialsStore, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes.debug).toBeUndefined();
	});

	test('a POST /set subscribe entry naming origin/.../core/... is no longer rewritten', async () => {
		const { store, credentialsStore, activeRoles } = setup();
		const result = await buildSetResponse(
			{ subscribe: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'] },
			activeRoles,
			{ store, credentialsStore, warn: () => {} },
		);
		expect(result.status).toBe(200);
		expect(result.body.changes.subscribe).toEqual({ value: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'], changed: true });
	});
});

describe('buildSetResponse — deprecated whitelist/blacklist keys (ADR 0012)', () => {
	test('POST {whitelist: [...]} applies to subscribe, reports the change under the new key, and warns', async () => {
		const { store, credentialsStore, activeRoles } = setup();
		const warnings: string[] = [];
		const result = await buildSetResponse({ whitelist: ['cache/a/wis2/#'] }, activeRoles, { store, credentialsStore, warn: (m) => warnings.push(m) });
		expect(result.status).toBe(200);
		expect(result.body.changes.subscribe).toEqual({ value: ['cache/a/wis2/#'], changed: true });
		expect(result.body.warnings).toEqual(["whitelist: deprecated, use 'subscribe'."]);
		expect(warnings).toEqual(["whitelist: deprecated, use 'subscribe'."]);
		expect(store.getSubscribe()).toEqual(['cache/a/wis2/#']);
	});
});
