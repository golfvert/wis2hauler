import { describe, expect, test } from 'bun:test';
import { buildSetResponse } from '../set.ts';
import { RuntimeConfigStore } from '../runtime-store.ts';
import { DebugController } from '../../debug.ts';
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
		mqtt: { whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] },
	},
};

function setup(roles: Role[] = ['SUBSCRIBER', 'DOWNLOADER']) {
	const store = new RuntimeConfigStore(config);
	const credentialsStore = new FakeDownloaderStore();
	const debug = new DebugController();
	const activeRoles = new Set<Role>(roles);
	return { store, credentialsStore, debug, activeRoles, warn: () => {} };
}

describe('buildSetResponse', () => {
	test('valid patch: 200, changes reflects value + changed', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'debug' }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(200);
		expect(result.body.changes['log-level']).toEqual({ value: 'debug', changed: true });
		expect(result.body.errors).toBeUndefined();
	});

	test('invalid body (not an object): 400, no changes', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse('nope', activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes).toEqual({});
		expect(result.body.errors).toContain('Body must be a JSON object.');
	});

	test('a patch with only invalid keys: 400, errors surfaced, nothing applied', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'verbose' }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes).toEqual({});
		expect(result.body.errors?.some((e) => e.startsWith('log-level:'))).toBe(true);
	});

	test('a mixed patch: valid keys apply and are reported, invalid ones are listed in errors', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ 'log-level': 'debug', bogus: true }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(200);
		expect(result.body.changes['log-level']).toEqual({ value: 'debug', changed: true });
		expect(result.body.errors).toContain('bogus: unknown key.');
	});

	test('credentials create: applies a real HSET via the credentials store, reports changed', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' } },
			activeRoles,
			{ store, credentialsStore, debug, warn },
		);
		expect(result.status).toBe(200);
		expect(result.body.changes.credentials).toEqual({ value: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u' }, changed: true });
		expect(await credentialsStore.getCredentials()).toContain('origin/a/wis2/us-noaa/data/recommended');
	});

	test('credentials delete: changed:false when the topic never existed', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ credentials: { op: 'delete', topic: 'origin/a/wis2/nope-noaa/data/recommended' } }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.body.changes.credentials).toEqual({ value: { op: 'delete', topic: 'origin/a/wis2/nope-noaa/data/recommended' }, changed: false });
	});

	test('credentials role-gated: SUBSCRIBER-only replica cannot touch credentials', async () => {
		const { store, credentialsStore, debug, warn } = setup(['SUBSCRIBER']);
		const result = await buildSetResponse(
			{ credentials: { op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' } },
			new Set<Role>(['SUBSCRIBER']),
			{ store, credentialsStore, debug, warn },
		);
		expect(result.status).toBe(400);
		expect(result.body.errors).toContain('credentials: not available for current roles.');
	});

	test('debug: valid categories are applied to the DebugController and reported changed', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ debug: ['subscriber', 'downloader'] }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(200);
		expect(result.body.changes.debug).toEqual({ value: ['SUBSCRIBER', 'DOWNLOADER'], changed: true });
		expect(debug.has('SUBSCRIBER')).toBe(true);
		expect(debug.has('DOWNLOADER')).toBe(true);
		expect(debug.has('CLEANER')).toBe(false);
	});

	test('debug: an empty array clears every dynamically-set category, reported changed', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		debug.setDynamic(['SUBSCRIBER']);
		const result = await buildSetResponse({ debug: [] }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.body.changes.debug).toEqual({ value: [], changed: true });
		expect(debug.has('SUBSCRIBER')).toBe(false);
	});

	test('debug: re-setting the same categories (any order) reports changed:false', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		debug.setDynamic(['SUBSCRIBER', 'DOWNLOADER']);
		const result = await buildSetResponse({ debug: ['downloader', 'subscriber'] }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.body.changes.debug?.changed).toBe(false);
		expect((result.body.changes.debug?.value as string[]).sort()).toEqual(['DOWNLOADER', 'SUBSCRIBER']);
	});

	test('debug: an unknown category is rejected -- 400, nothing applied', async () => {
		const { store, credentialsStore, debug, activeRoles, warn } = setup();
		const result = await buildSetResponse({ debug: ['bogus'] }, activeRoles, { store, credentialsStore, debug, warn });
		expect(result.status).toBe(400);
		expect(result.body.changes).toEqual({});
		expect(result.body.errors?.some((e) => e.startsWith('debug[0]:'))).toBe(true);
		expect(debug.has('SUBSCRIBER')).toBe(false);
	});

	// The WIS2 core/cache rule used to rewrite an origin/.../core/...
	// whitelist entry to cache/... right here (a POST /set went through
	// the same enforceCoreCacheRule as static-config load). Removed
	// 2026-09-19 -- see ../../config/topics.ts's removal comment: a
	// broad wildcard whitelist entry bypassed it entirely, and nothing
	// downstream ever re-checked a message's ACTUAL topic once
	// received. The replacement enforcement runs at message-ingest time
	// instead (../../subscriber/ingest.ts), so a POST /set no longer
	// needs (or has) any core/cache-specific handling of its own.
	test('a POST /set whitelist entry naming origin/.../core/... is no longer rewritten', async () => {
		const { store, credentialsStore, debug, activeRoles } = setup();
		const result = await buildSetResponse(
			{ whitelist: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'] },
			activeRoles,
			{ store, credentialsStore, debug, warn: () => {} },
		);
		expect(result.status).toBe(200);
		expect(result.body.changes.whitelist).toEqual({ value: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'], changed: true });
	});
});
