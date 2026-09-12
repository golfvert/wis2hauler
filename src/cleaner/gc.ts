// The Cleaner tab's "Clean Redis" function node (cleanup_function_simple)
// -- ported field-for-field, including its pre-existing quirks (kept,
// not "fixed", per "NO GUESS"). Fed by the "Clean" inject
// (cleanup_inject_simple, onceDelay 0.1s, repeat 21600s = 6h) through
// the "Cleaner ?" gate (2ae60817cedd9bde: cleaner-primary && run-mode
// -- NOTE: unlike Schedule/Sweep's gate, this one does NOT also check
// cleaning-needed; the original GC's own scan target (stale
// downloader:* bookkeeping hashes) is independent of whether local
// files are currently being kept, so it runs on this schedule
// regardless).
//
// The original hardcodes `THRESHOLD = 12 * 3600` and always calls
// `redis.nodes('master')` (an ioredis Cluster-only method) --
// GC_DEFAULT_THRESHOLD_SECONDS below preserves that literal default,
// and the config-driven override (schema.ts's
// cleaner['redis-gc-threshold-seconds']) is an original addition (see
// schema.ts's comment on that field). The Cluster-only `.nodes('master')`
// call is mode-aware here since this Bun port also supports single-node
// Redis (the maintainer's "option of cluster or single node") -- see
// ../redis/ioredis-cleaner-store.ts's GcStore implementation for the
// branching; this file only sees the resulting GcScanNode[] abstraction.
export const GC_ONCE_DELAY_MS = 100;
export const GC_INTERVAL_MS = 21600 * 1000;
export const GC_DEFAULT_THRESHOLD_SECONDS = 12 * 3600;

export const GC_KEY_PATTERNS = [
	'wis2gc:downloader:*:stream_id:*',
	'wis2gc:downloader:*:aria2_gid:*',
	'wis2gc:downloader:downloader_id:*',
	'wis2gc:downloader:complete:*',
] as const;

/** The 6 pattern names the original's `stats.byPattern` initializes -- deliberately does NOT include 'other' (see classifyGcKey's doc: an 'other'-classified deleted key still counts toward totalDeleted/byType but is silently NOT counted in byPattern, matching the original's `if (stats.byPattern[patternName] !== undefined)` guard). */
export type GcPatternName = 'stream_id' | 'stream_id:expire' | 'aria2_gid' | 'aria2_gid:expire' | 'downloader_id' | 'complete';

/** Classifies a matched key exactly like the original's getPatternName -- order matters: the ":expire" suffix checks run before their non-expire counterparts. Returns 'other' for anything that matches none of the 6 named patterns (the GC_KEY_PATTERNS globs are broad enough that this can still happen); 'other' is a valid classification but is NOT one of GcPatternName's 6 values, so callers must handle it separately (see runGcPattern). */
export function classifyGcKey(key: string): GcPatternName | 'other' {
	if (key.includes(':stream_id:') && key.endsWith(':expire')) return 'stream_id:expire';
	if (key.includes(':stream_id:')) return 'stream_id';
	if (key.includes(':aria2_gid:') && key.endsWith(':expire')) return 'aria2_gid:expire';
	if (key.includes(':aria2_gid:')) return 'aria2_gid';
	if (key.includes(':downloader_id:')) return 'downloader_id';
	if (key.includes(':complete:')) return 'complete';
	return 'other';
}

/** A key is deleted only if it has no TTL at all (ttl === -1, i.e. was never given one) AND has sat idle longer than the threshold -- matching the original's `ttl === -1 && idle > THRESHOLD` exactly (a key WITH a TTL is left alone no matter how idle, on the assumption Redis will expire it on its own). */
export function shouldDeleteGcKey(ttl: number, idle: number, thresholdSeconds: number): boolean {
	return ttl === -1 && idle > thresholdSeconds;
}

export interface GcStats {
	totalDeleted: number;
	byType: { hash: number; string: number; other: number };
	byPattern: Record<GcPatternName, number>;
	errors: number;
}

export function createGcStats(): GcStats {
	return {
		totalDeleted: 0,
		byType: { hash: 0, string: 0, other: 0 },
		byPattern: {
			'stream_id': 0,
			'stream_id:expire': 0,
			'aria2_gid': 0,
			'aria2_gid:expire': 0,
			'downloader_id': 0,
			complete: 0,
		},
		errors: 0,
	};
}

/** One shard's SCAN + pipelined TTL/IDLETIME/TYPE inspection surface -- for a Cluster this is one master node, for single-node Redis it's the one connection itself (see ioredis-cleaner-store.ts). */
export interface GcScanNode {
	/** SCAN cursor MATCH pattern COUNT count -- returns [newCursor, matchedKeys]. */
	scan(cursor: string, pattern: string, count: number): Promise<[string, string[]]>;
	/** Pipelined TTL + OBJECT IDLETIME + TYPE for one key -- null if any of the three pipeline results carried an error (matching the original's `results.some(r => r[0])` skip-on-any-error behavior). */
	inspect(key: string): Promise<{ ttl: number; idle: number; type: string } | null>;
}

export interface GcStore {
	getScanNodes(): GcScanNode[];
	/** DEL routed through the top-level connection (not per-shard) -- matches the original's `redis.del(key)`, which is always called on the cluster-wide (or single-node) client, never on a specific masterNode. */
	del(key: string): Promise<void>;
}

async function runGcPattern(store: GcStore, pattern: string, thresholdSeconds: number, stats: GcStats, warn: (message: string) => void): Promise<void> {
	for (const node of store.getScanNodes()) {
		let cursor = '0';
		do {
			let scanned: [string, string[]];
			try {
				scanned = await node.scan(cursor, pattern, 100);
			} catch (err) {
				warn(`Error scanning: ${err instanceof Error ? err.message : String(err)}`);
				break;
			}
			const [newCursor, keys] = scanned;
			cursor = newCursor;

			for (const key of keys) {
				try {
					const inspected = await node.inspect(key);
					if (!inspected) continue;
					if (!shouldDeleteGcKey(inspected.ttl, inspected.idle, thresholdSeconds)) continue;

					await store.del(key);
					stats.totalDeleted++;
					if (inspected.type === 'hash') stats.byType.hash++;
					else if (inspected.type === 'string') stats.byType.string++;
					else stats.byType.other++;

					const patternName = classifyGcKey(key);
					if (patternName !== 'other') stats.byPattern[patternName]++;
				} catch {
					stats.errors++;
				}
			}
		} while (cursor !== '0');
	}
}

export async function runGcSweep(store: GcStore, thresholdSeconds: number, warn: (message: string) => void): Promise<GcStats> {
	const stats = createGcStats();
	for (const pattern of GC_KEY_PATTERNS) {
		await runGcPattern(store, pattern, thresholdSeconds, stats, warn);
	}
	return stats;
}
