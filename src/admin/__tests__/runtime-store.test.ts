import { describe, expect, test } from 'bun:test';
import { RuntimeConfigStore } from '../runtime-store.ts';
import type { Config } from '../../config/schema.ts';

function makeConfig(overrides: Partial<Config['global']> = {}): Config {
	return {
		global: {
			roles: 'SUBSCRIBER,DOWNLOADER',
			worker: 'downloader1',
			redis: { mode: 'single', nodes: ['localhost:6379'] },
			queue: 'wis2gc',
			log: { level: 'info' },
			...overrides,
		},
		subscriber: {
			'global-broker': [{ broker: 'mqtts://example.com' }],
			mqtt: {
				whitelist: ['origin/a/wis2/fr-meteofrance/data/x'],
				blacklist: ['origin/a/wis2/blocked/#'],
				overridelist: [{ topic: 'origin/a/wis2/big/#', 'max-length': 10 }],
				'global-replay': 'https://replay.example.com',
			},
		},
	};
}

describe('RuntimeConfigStore', () => {
	test('seeds from config: log-level, whitelist/blacklist/overridelist, global-replay', () => {
		const store = new RuntimeConfigStore(makeConfig());
		expect(store.getLogLevel()).toBe('info');
		expect(store.getProcessMode()).toBe('run');
		expect(store.getWhitelist()).toEqual(['origin/a/wis2/fr-meteofrance/data/x']);
		expect(store.getBlacklist()).toEqual(['origin/a/wis2/blocked/#']);
		expect(store.getOverridelist()).toEqual([{ topic: 'origin/a/wis2/big/#', 'max-length': 10 }]);
		expect(store.getGlobalReplay()).toBe('https://replay.example.com');
	});

	test('effectiveLevel: falls back to the plain log-level with no role or no override', () => {
		const store = new RuntimeConfigStore(makeConfig());
		expect(store.effectiveLevel()).toBe('info');
		expect(store.effectiveLevel('SUBSCRIBER')).toBe('info');
	});

	test('effectiveLevel: a per-role override (log-level-role) wins for that role only', () => {
		const store = new RuntimeConfigStore(makeConfig());
		store.applyPatch({ 'log-level-role': { role: 'SUBSCRIBER', value: 'debug' } });
		expect(store.effectiveLevel('SUBSCRIBER')).toBe('debug');
		expect(store.effectiveLevel('DOWNLOADER')).toBe('info');
		expect(store.effectiveLevel()).toBe('info');
	});

	test('applyPatch: log-level-role value null clears a previously-set override', () => {
		const store = new RuntimeConfigStore(makeConfig());
		store.applyPatch({ 'log-level-role': { role: 'SUBSCRIBER', value: 'debug' } });
		expect(store.effectiveLevel('SUBSCRIBER')).toBe('debug');

		const changes = store.applyPatch({ 'log-level-role': { role: 'SUBSCRIBER', value: null } });
		expect(store.effectiveLevel('SUBSCRIBER')).toBe('info');
		expect(changes['log-level-role']).toEqual({ value: { role: 'SUBSCRIBER', value: null }, changed: true });
	});

	test('applyPatch: reports changed:false when a value is re-applied unchanged', () => {
		const store = new RuntimeConfigStore(makeConfig());
		const first = store.applyPatch({ 'log-level': 'debug' });
		expect(first['log-level']).toEqual({ value: 'debug', changed: true });

		const second = store.applyPatch({ 'log-level': 'debug' });
		expect(second['log-level']).toEqual({ value: 'debug', changed: false });
	});

	test('applyPatch: whitelist/blacklist/overridelist replace wholesale and report changed correctly', () => {
		const store = new RuntimeConfigStore(makeConfig());
		const changes = store.applyPatch({ whitelist: ['origin/a/wis2/other/data/y'] });
		expect(store.getWhitelist()).toEqual(['origin/a/wis2/other/data/y']);
		expect(changes.whitelist).toEqual({ value: ['origin/a/wis2/other/data/y'], changed: true });

		const noop = store.applyPatch({ whitelist: ['origin/a/wis2/other/data/y'] });
		expect(noop.whitelist?.changed).toBe(false);
	});

	test('applyPatch: process-mode', () => {
		const store = new RuntimeConfigStore(makeConfig());
		const changes = store.applyPatch({ 'process-mode': 'halt' });
		expect(store.getProcessMode()).toBe('halt');
		expect(changes['process-mode']).toEqual({ value: 'halt', changed: true });
	});

	test('applyPatch: credentials key is ignored -- that is admin/set.ts applyCredentialsOp\'s job', () => {
		const store = new RuntimeConfigStore(makeConfig());
		const changes = store.applyPatch({ credentials: { op: 'delete', topic: 'x' } });
		expect(changes.credentials).toBeUndefined();
	});

	test('setGlobalReplay', () => {
		const store = new RuntimeConfigStore(makeConfig());
		const changed = store.setGlobalReplay('https://new-replay.example.com');
		expect(changed).toEqual({ value: 'https://new-replay.example.com', changed: true });
		expect(store.getGlobalReplay()).toBe('https://new-replay.example.com');

		const noop = store.setGlobalReplay('https://new-replay.example.com');
		expect(noop.changed).toBe(false);
	});

	test('missing subscriber section seeds empty whitelist/blacklist/overridelist and null global-replay', () => {
		const config: Config = {
			global: { roles: 'DOWNLOADER', worker: 'w1', redis: { mode: 'single', nodes: ['localhost:6379'] }, log: { level: 'warn' } },
		};
		const store = new RuntimeConfigStore(config);
		expect(store.getWhitelist()).toEqual([]);
		expect(store.getBlacklist()).toEqual([]);
		expect(store.getOverridelist()).toEqual([]);
		expect(store.getGlobalReplay()).toBeNull();
		expect(store.getLogLevel()).toBe('warn');
	});
});
