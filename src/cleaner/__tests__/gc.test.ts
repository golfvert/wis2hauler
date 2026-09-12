import { describe, expect, test } from 'bun:test';
import { classifyGcKey, createGcStats, GC_KEY_PATTERNS, runGcSweep, shouldDeleteGcKey, type GcScanNode, type GcStore } from '../gc.ts';

describe('classifyGcKey', () => {
	test('an :expire-suffixed stream_id key classifies as stream_id:expire, not stream_id', () => {
		expect(classifyGcKey('wis2gc:downloader:worker-1:stream_id:1234:expire')).toBe('stream_id:expire');
	});
	test('a plain stream_id key classifies as stream_id', () => {
		expect(classifyGcKey('wis2gc:downloader:worker-1:stream_id:1234')).toBe('stream_id');
	});
	test('an :expire-suffixed aria2_gid key classifies as aria2_gid:expire', () => {
		expect(classifyGcKey('wis2gc:downloader:worker-1:aria2_gid:abc:expire')).toBe('aria2_gid:expire');
	});
	test('a plain aria2_gid key classifies as aria2_gid', () => {
		expect(classifyGcKey('wis2gc:downloader:worker-1:aria2_gid:abc')).toBe('aria2_gid');
	});
	test('downloader_id and complete classify directly', () => {
		expect(classifyGcKey('wis2gc:downloader:downloader_id:xyz')).toBe('downloader_id');
		expect(classifyGcKey('wis2gc:downloader:complete:xyz')).toBe('complete');
	});
	test('anything matching none of the named substrings classifies as other', () => {
		expect(classifyGcKey('wis2gc:downloader:worker-1:something-else:xyz')).toBe('other');
	});
});

describe('shouldDeleteGcKey', () => {
	test('deletes only keys with no TTL (-1) that have sat idle past the threshold', () => {
		expect(shouldDeleteGcKey(-1, 50000, 43200)).toBe(true);
		expect(shouldDeleteGcKey(-1, 100, 43200)).toBe(false);
	});
	test('a key WITH a TTL is never deleted, no matter how idle', () => {
		expect(shouldDeleteGcKey(3600, 999999, 43200)).toBe(false);
	});
});

function makeFakeStore(keysByPattern: Record<string, { key: string; ttl: number; idle: number; type: string }[]>): { store: GcStore; deleted: string[] } {
	const deleted: string[] = [];
	const node: GcScanNode = {
		async scan(_cursor, pattern) {
			const entries = keysByPattern[pattern] ?? [];
			return ['0', entries.map((e) => e.key)];
		},
		async inspect(key) {
			for (const entries of Object.values(keysByPattern)) {
				const found = entries.find((e) => e.key === key);
				if (found) return { ttl: found.ttl, idle: found.idle, type: found.type };
			}
			return null;
		},
	};
	const store: GcStore = {
		getScanNodes: () => [node],
		del: async (key) => {
			deleted.push(key);
		},
	};
	return { store, deleted };
}

describe('runGcSweep', () => {
	test('scans every GC_KEY_PATTERN and deletes only keys past the idle threshold with no TTL', async () => {
		const [p1] = GC_KEY_PATTERNS;
		const { store, deleted } = makeFakeStore({
			[p1!]: [
				{ key: 'wis2gc:downloader:w1:stream_id:1:expire', ttl: -1, idle: 50000, type: 'string' },
				{ key: 'wis2gc:downloader:w1:stream_id:2', ttl: -1, idle: 10, type: 'hash' },
				{ key: 'wis2gc:downloader:w1:stream_id:3', ttl: 60, idle: 999999, type: 'hash' },
			],
		});
		const stats = await runGcSweep(store, 43200, () => {});
		expect(deleted).toEqual(['wis2gc:downloader:w1:stream_id:1:expire']);
		expect(stats.totalDeleted).toBe(1);
		expect(stats.byType).toEqual({ hash: 0, string: 1, other: 0 });
		expect(stats.byPattern['stream_id:expire']).toBe(1);
		expect(stats.byPattern.stream_id).toBe(0);
	});

	test('a deleted key that classifies as "other" counts toward totalDeleted/byType but NOT byPattern -- the original quirk', async () => {
		const [p1] = GC_KEY_PATTERNS;
		const { store } = makeFakeStore({
			[p1!]: [{ key: 'wis2gc:downloader:w1:unrelated:1', ttl: -1, idle: 999999, type: 'hash' }],
		});
		const stats = await runGcSweep(store, 43200, () => {});
		expect(stats.totalDeleted).toBe(1);
		expect(stats.byType.hash).toBe(1);
		expect(Object.values(stats.byPattern).every((v) => v === 0)).toBe(true);
	});

	test('a pipeline error on one key (inspect returns null) is skipped without affecting other keys', async () => {
		const [p1] = GC_KEY_PATTERNS;
		const deleted: string[] = [];
		const node: GcScanNode = {
			async scan(_cursor, pattern) {
				return ['0', pattern === p1 ? ['bad-key', 'good-key'] : []];
			},
			async inspect(key) {
				if (key === 'bad-key') return null;
				return { ttl: -1, idle: 999999, type: 'string' };
			},
		};
		const store: GcStore = { getScanNodes: () => [node], del: async (k) => void deleted.push(k) };
		const stats = await runGcSweep(store, 43200, () => {});
		expect(deleted).toEqual(['good-key']);
		expect(stats.totalDeleted).toBe(1);
	});

	test('a del() throw is counted as an error, not thrown out of the sweep', async () => {
		const [p1] = GC_KEY_PATTERNS;
		const node: GcScanNode = {
			async scan(_cursor, pattern) {
				return ['0', pattern === p1 ? ['some-key'] : []];
			},
			async inspect() {
				return { ttl: -1, idle: 999999, type: 'string' };
			},
		};
		const store: GcStore = {
			getScanNodes: () => [node],
			del: async () => {
				throw new Error('redis error');
			},
		};
		const stats = await runGcSweep(store, 43200, () => {});
		expect(stats.errors).toBe(1);
		expect(stats.totalDeleted).toBe(0);
	});

	test('createGcStats starts every counter at zero', () => {
		const stats = createGcStats();
		expect(stats.totalDeleted).toBe(0);
		expect(stats.errors).toBe(0);
		expect(Object.values(stats.byType).every((v) => v === 0)).toBe(true);
	});
});
