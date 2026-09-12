// Real ReporterStore, backed by ioredis. Reuses
// ./ioredis-store.ts's createRedisConnection() helper for the same
// cluster-or-single-node reason every other real store in this
// project does. The header comment this replaced claimed nothing
// here needed ../cleaner/gc.ts's GcStore-style Cluster
// `.nodes('master')` branching, reasoning that every multi/pipeline
// below touches keys sharing one `{windowKey}` hash tag so they land
// on a single Cluster slot -- true for `.multi()`/`.pipeline()`
// (ioredis derives a command's target slot from an explicit KEY
// argument, e.g. `multi.hincrby(totalKey, ...)`), but readWindowStats
// below ALSO called `this.redis.keys(pattern)`, and KEYS takes a
// PATTERN, not a key -- Command.getKeys() (node_modules/ioredis/built/
// Command.js) returns [] for it, so Command.getSlot() is null, and
// ioredis's Cluster.sendCommand (node_modules/ioredis/built/cluster/
// index.js) falls through its targetSlot-routing branch straight to
// `connectionPool.getSampleInstance(to)` -- a RANDOM master node,
// every single call, with no awareness of the `{windowKey}` hash tag
// in the pattern string at all. Found 2026-09-11: the maintainer, on their real
// 3-master Cluster ("redis-1/redis-2/redis-3") -- "More download
// [than] the count on metrics. Even with the 30s delay." -- with 3
// masters, ~2 calls out of 3 landed on a node that simply doesn't
// hold that window's `{windowKey}`-tagged keys and came back with
// ZERO matches, silently reporting an empty window even though the
// writes (which DO carry an explicit key, so route correctly) had
// gone through fine -- not a timing/delay issue, a wrong-node read on
// most polls. Fixed below with the exact same fan-out-over-every-
// master-and-SCAN approach ../cleaner/gc.ts's GcStore already uses
// for this precise problem (a pattern with no single routable key) --
// see scanAllNodes()'s own comment.
import { Cluster } from 'ioredis';
import type { RedisConnection } from './ioredis-store.ts';
import type { ReporterStore, WindowStats } from '../reporter/store.ts';
import type { StatsWriteCommand } from '../reporter/stats.ts';
import { LUA_ACTIVE_IPS } from '../reporter/active-ips.ts';
import { infoGranuleKey, reporterActiveIpsKey, statsComboKey, statsComboKeyPattern, statsSrcKey, statsSrcKeyPattern, statsTotalKey } from '../wis2/redis-keys.ts';

/**
 * KEYS/SCAN have no derivable Cluster slot from a pattern alone, so a
 * command sent straight to `redis` (a Cluster instance) lands on one
 * random master -- see this file's header. Every key `pattern` this
 * store searches for is hash-tagged to one specific window
 * (`{windowKey}:combo:*` etc.), so the actual data lives on exactly
 * ONE master's slot; fanning the SCAN out to every master (one, for a
 * single-node deployment) is guaranteed to find it there regardless
 * of which random node a plain `.keys()`/`.scan()` call would have
 * hit, at the cost of a handful of cheap no-op SCANs against the
 * masters that don't hold it -- the same trade-off ../cleaner/gc.ts's
 * GcStore already makes for its own pattern-scan needs.
 */
async function scanAllNodes(redis: RedisConnection, pattern: string): Promise<string[]> {
	const nodes: RedisConnection[] = redis instanceof Cluster ? (redis.nodes('master') as unknown as RedisConnection[]) : [redis];
	const keys: string[] = [];
	for (const node of nodes) {
		let cursor = '0';
		do {
			const reply = (await node.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', '200')) as [string, string[]];
			cursor = reply[0];
			keys.push(...reply[1]);
		} while (cursor !== '0');
	}
	return keys;
}

export class IoredisReporterStore implements ReporterStore {
	constructor(private readonly redis: RedisConnection) {}

	async writeStatsWindow(cmd: StatsWriteCommand): Promise<void> {
		const totalKey = statsTotalKey(cmd.windowKey);
		const comboKey = statsComboKey(cmd.windowKey, cmd.centreIdSegment, cmd.subtopicSegment);

		const multi = this.redis.multi();
		multi.hincrby(totalKey, 'count', 1);
		multi.hincrby(totalKey, 'totalLength', cmd.length);
		// A genuinely null delay is written as 0 -- see stats.ts's header note (defensive; HINCRBY requires an integer).
		multi.hincrby(totalKey, 'totalDelay', cmd.delay ?? 0);
		multi.hincrby(comboKey, 'count', 1);
		multi.hincrby(comboKey, 'totalLength', cmd.length);
		multi.hincrby(comboKey, 'totalDelay', cmd.delay ?? 0);
		multi.hset(comboKey, 'lastTimestamp', String(cmd.lastTimestamp || 0));
		multi.expire(totalKey, 3600);
		multi.expire(comboKey, 3600);
		if (cmd.source) {
			const srcKey = statsSrcKey(cmd.windowKey, cmd.centreIdSegment, cmd.source);
			multi.hincrby(srcKey, 'count', 1);
			multi.expire(srcKey, 3600);
		}
		await multi.exec();
	}

	async readWindowStats(windowKey: string): Promise<WindowStats> {
		// Fetched for fidelity (the original's `multi.hgetall(\`{${windowKey}}:total\`)`) -- its
		// result is never used downstream, see metrics.ts's header note.
		await this.redis.hgetall(statsTotalKey(windowKey));

		const comboKeys = await scanAllNodes(this.redis, statsComboKeyPattern(windowKey));
		const srcKeys = await scanAllNodes(this.redis, statsSrcKeyPattern(windowKey));

		const detailPipeline = this.redis.pipeline();
		for (const key of comboKeys) detailPipeline.hgetall(key);
		for (const key of srcKeys) detailPipeline.hgetall(key);
		const detailResults = comboKeys.length + srcKeys.length > 0 ? await detailPipeline.exec() : [];

		const comboEntries = comboKeys.map((key, idx) => ({ key, stats: (detailResults?.[idx]?.[1] as Record<string, string> | undefined) ?? {} }));
		const srcEntries = srcKeys.map((key, idx) => ({
			key,
			stats: (detailResults?.[comboKeys.length + idx]?.[1] as Record<string, string> | undefined) ?? {},
		}));

		return { comboEntries, srcEntries };
	}

	async readGranule(uri: string): Promise<string[]> {
		const reply = await this.redis.call('HGETALL', infoGranuleKey(uri));
		return (reply as string[] | null) ?? [];
	}

	async recordActiveIp(ip: string, keepIpSeconds: number): Promise<number> {
		const result = await this.redis.eval(LUA_ACTIVE_IPS, 1, reporterActiveIpsKey(), ip, String(keepIpSeconds));
		return Number(result) || 0;
	}

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}
