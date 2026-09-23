// Real SubscriberStore, backed by ioredis. Supports both deployment
// modes the maintainer asked for -- "the option of using redis as a cluster or
// as a single node" -- via config/schema.ts's RedisConfig.mode:
// 'cluster' constructs an ioredis Cluster over the configured seed
// nodes, 'single' constructs a plain ioredis client against the one
// configured node. Both expose the same command surface this file
// needs (set/exists/hset/expire/xadd/xread/del), so the rest of this
// module doesn't need to know which mode it's running under.
import Redis, { Cluster } from 'ioredis';
import type { RedisConfig } from '../config/schema.ts';
import type { RawStreamEntry, SubscriberStore } from '../subscriber/store.ts';
import {
	downloaderClaimKey,
	downloaderCompleteKey,
	downloaderHashKey,
	mqttRawStreamKey,
	subscriberGlobalCacheLineageKey,
	subscriberLineageKey,
	wnmIdDedupKey,
	workQueueStreamKey,
} from '../wis2/redis-keys.ts';

// Backstop cap for the raw ingest stream (appendRawMessage's XADD
// MAXLEN below) -- 2026-09-21, raised 10000 -> 100000 -> 500000 over
// one deployment's live investigation, and demoted from PRIMARY trim
// mechanism to BACKSTOP the same day. Full history: a live trace
// found several wnm.id's whose Filter log showed "ingested" (XADD
// succeeded) with NO trace of ANY kind afterward -- consumer.ts's
// processEntry simply never called -- because MAXLEN's approximate
// trim had evicted them before runConsumerLoop's XREAD ever reached
// them; at that deployment's real ingest rate (~73 msg/s onto ONE
// stream, inflated by weight-sources' redundancy -- every distinct
// global cache re-mints its own wnm.id for the same underlying
// data_id) the original 10000 cap held barely two minutes of history,
// close enough to this pipeline's own worst-case per-message delay
// (weight-delay-max-seconds, 120s) plus maxInFlight=5000 backpressure
// (which pauses READING, not writing -- ingest.ts's onMessage is
// never gated by consumer state) that an ordinary burst or Redis
// blip was enough to start silently evicting unread entries. Raising
// the cap alone (10000 -> 100000) only ever bought a bigger blind
// buffer -- it didn't fix the actual mismatch: a COUNT-based cap has
// no idea whether the consumer has actually reached those entries, so
// under continuous high-volume ingest the stream simply sits pinned
// at/near whatever the cap is, forever, healthy or not (confirmed
// live: XLEN sat at ~100000 for hours regardless of load).
//
// Real fix, same day: runConsumerLoop now runs a periodic
// `XTRIM ... MINID ~ <lastId minus a margin>` (stream-id.ts's
// streamIdMinusMs) as the PRIMARY trim, keyed off the consumer's own
// read cursor -- structurally unable to remove anything the consumer
// hasn't reached yet, unlike a blind count. That lets the stream
// actually shrink back down whenever the consumer is caught up,
// instead of sitting permanently pinned at a fixed number. This
// MAXLEN constant is what's left afterward: a rare backstop against
// truly unbounded growth if the consumer is dead (crashed, not
// restarting) rather than just temporarily behind -- raised to
// 500000 (5x the old primary-mechanism cap) specifically because it's
// now expected to almost never be the thing actually trimming
// anything; routine operation should keep the stream far below it.
export const RAW_STREAM_MAXLEN = 500_000;

export type RedisConnection = Redis | Cluster;

export function createRedisConnection(config: RedisConfig): RedisConnection {
	const nodes = config.nodes.map((n) => {
		const idx = n.lastIndexOf(':');
		return { host: n.slice(0, idx), port: Number(n.slice(idx + 1)) };
	});

	if (config.mode === 'cluster') {
		return new Cluster(nodes, {
			redisOptions: config.password ? { password: config.password } : {},
		});
	}

	// 'single' -- validate.ts's cross-check guarantees exactly one node
	// by the time a config reaches here, but fall back to the first
	// entry defensively rather than throwing if that's ever bypassed.
	const [node] = nodes;
	if (!node) throw new Error('global.redis.nodes: at least one "host:port" entry is required');
	return new Redis({ host: node.host, port: node.port, password: config.password });
}

// Small helper for the pipelined HSET+EXPIRE writes below
// (writeDownloadJob, recordLineagePubtime, recordGlobalCacheLineagePubtime)
// -- added 2026-09-23 while investigating SUBSCRIBER's per-message Redis
// round-trip cost. Unlike two separate awaited calls (which throw
// immediately on failure), ioredis's pipeline().exec() resolves with an
// array of [error, result] pairs and does NOT reject just because one
// command inside it failed -- silently swallowing that would be a
// regression from today's behavior, so this re-throws the first error
// found, preserving the same fail-loud semantics the two-round-trip
// version had.
function assertPipelineOk(results: Array<[Error | null, unknown]> | null): void {
	if (!results) throw new Error('redis pipeline returned no results (connection issue?)');
	for (const [err] of results) {
		if (err) throw err;
	}
}

export class IoredisStore implements SubscriberStore {
	constructor(private readonly redis: RedisConnection) {}

	async claimMessageId(wnmId: string, ttlSeconds: number): Promise<boolean> {
		const result = await this.redis.set(wnmIdDedupKey(wnmId), 'true', 'EX', ttlSeconds, 'NX');
		return result === 'OK';
	}

	async appendRawMessage(queue: string, topic: string, payload: string, timestampMs: number): Promise<string> {
		const id = await this.redis.xadd(
			mqttRawStreamKey(queue),
			'MAXLEN',
			'~',
			RAW_STREAM_MAXLEN,
			'*',
			'topic',
			topic,
			'payload',
			payload,
			'timestamp',
			String(timestampMs),
		);
		if (!id) throw new Error(`XADD on ${mqttRawStreamKey(queue)} returned no ID`);
		return id;
	}

	async readRawMessages(queue: string, lastId: string, count: number): Promise<RawStreamEntry[]> {
		// No BLOCK -- the original's "Read" -> "XREAD" is a plain,
		// non-blocking read; the poll cadence lives in run.ts's interval.
		const reply = await this.redis.xread('COUNT', count, 'STREAMS', mqttRawStreamKey(queue), lastId);
		if (!reply) return [];
		// ioredis's xread reply shape: [[streamKey, [[id, [field, value, ...]], ...]]]
		const [[, entries]] = reply as unknown as [[string, [string, string[]][]]];
		return entries.map(([id, fields]) => {
			const map: Record<string, string> = {};
			for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
			return { id, topic: map.topic ?? '', payload: map.payload ?? '' };
		});
	}

	// See SubscriberStore.getRawStreamLength's own doc comment.
	async getRawStreamLength(queue: string): Promise<number> {
		return this.redis.xlen(mqttRawStreamKey(queue));
	}

	// See SubscriberStore.getRawStreamOldestId's own doc comment. COUNT
	// 1 -- this only ever needs the single oldest entry's ID, not its
	// payload or any sibling entries, to answer "is the consumer's
	// lastId cursor still ahead of the trim horizon".
	async getRawStreamOldestId(queue: string): Promise<string | undefined> {
		const reply = (await this.redis.xrange(mqttRawStreamKey(queue), '-', '+', 'COUNT', 1)) as unknown as [string, string[]][];
		return reply[0]?.[0];
	}

	// See SubscriberStore.trimRawStreamBefore's own doc comment -- the
	// PRIMARY trim mechanism as of 2026-09-21 (MAXLEN above is now just
	// the backstop). `~` for the same lazy, whole-radix-tree-node
	// trimming MAXLEN already used: cheap on a high-volume stream, at
	// the cost of the same small overshoot MAXLEN's own approximate
	// trim already has -- this can leave a handful of entries older
	// than cutoffId still present, never fewer than requested. Returns
	// XTRIM's own return value (entries actually removed).
	async trimRawStreamBefore(queue: string, cutoffId: string): Promise<number> {
		return this.redis.xtrim(mqttRawStreamKey(queue), 'MINID', '~', cutoffId);
	}

	async checkAndClaimDownload(downloaderId: string, ttlSeconds: number): Promise<{ alreadyComplete: boolean; claimed: boolean }> {
		// REVERTED, 2026-09-23 (same day as the combine): the 2026-09-23
		// combine above used ONE EVAL with KEYS[1]=downloaderCompleteKey,
		// KEYS[2]=downloaderClaimKey -- two DIFFERENT key strings (no
		// shared hash tag) that hash to different slots on a real Redis
		// CLUSTER deployment (global.redis.mode: 'cluster' here -- this
		// codebase supports both cluster and single-node, and the combine
		// was only ever exercised against a single-node/fake store in
		// testing). Every real deployment immediately started throwing
		// "CROSSSLOT Keys in request don't hash to the same slot" on
		// EVERY call, i.e. every message that reached this point --
		// silently blocking all new downloads fleet-wide. Back to two
		// separate single-key round trips (the original behavior, minus
		// the interface split) until a cluster-safe combined version
		// (hash-tagging both keys, e.g. `...:{${downloaderId}}`, which
		// also needs a compatibility/migration pass since it changes the
		// literal key string) is designed and tested against a real
		// cluster, not just the in-memory fake.
		const alreadyComplete = (await this.redis.exists(downloaderCompleteKey(downloaderId))) === 1;
		const claimed = alreadyComplete ? false : (await this.redis.set(downloaderClaimKey(downloaderId), 'true', 'EX', ttlSeconds, 'NX')) === 'OK';
		return { alreadyComplete, claimed };
	}

	async initAttempt(downloaderId: string): Promise<void> {
		await this.redis.hset(downloaderHashKey(downloaderId), 'attempt', '1');
	}

	async writeDownloadJob(downloaderId: string, href: string, source: string, wnmJson: string, topic: string, published: string, dataId: string | undefined): Promise<void> {
		const key = downloaderHashKey(downloaderId);
		// PIPELINED, 2026-09-23 (previously two separate sequential round
		// trips, HSET then EXPIRE) -- see assertPipelineOk's doc comment
		// for the rationale: batches both commands into one network round
		// trip.
		assertPipelineOk(
			await this.redis
				.pipeline()
				.hset(key, {
					[href]: 'queue',
					[`src:${href}`]: source,
					wnm: wnmJson,
					topic,
					published,
					attempt: '1',
					data_id: dataId ?? '', // see store.ts's doc comment -- NOT a port, an extra field
				})
				.expire(key, 7200)
				.exec(),
		);
	}

	async enqueueWork(queue: string, downloaderId: string, href: string, topic: string, hasContent: boolean, dataId: string | undefined): Promise<void> {
		await this.redis.xadd(
			workQueueStreamKey(queue),
			'*',
			'downloader_id',
			downloaderId,
			'href',
			href,
			'topic',
			topic,
			'content',
			String(hasContent),
			'data_id', // see store.ts's doc comment -- NOT a port, an extra field
			dataId ?? '',
		);
	}

	async recordWait(downloaderId: string, href: string, source: string): Promise<void> {
		const key = downloaderHashKey(downloaderId);
		await this.redis.hset(key, {
			[href]: 'wait',
			[`src:${href}`]: source,
		});
	}

	async releaseClaim(downloaderId: string): Promise<void> {
		await this.redis.del(downloaderClaimKey(downloaderId));
	}

	async getLineagePubtimes(originCentreId: string, dataIdRaw: string): Promise<string[]> {
		const hash = await this.redis.hgetall(subscriberLineageKey(originCentreId, dataIdRaw));
		return Object.keys(hash);
	}

	async recordLineagePubtime(originCentreId: string, dataIdRaw: string, pubtime: string, nowMillis: number, ttlSeconds: number): Promise<void> {
		const key = subscriberLineageKey(originCentreId, dataIdRaw);
		// PIPELINED, 2026-09-23 (previously two separate sequential round
		// trips, HSET then EXPIRE) -- see writeDownloadJob's own comment
		// and assertPipelineOk's doc comment for the rationale.
		assertPipelineOk(await this.redis.pipeline().hset(key, pubtime, String(nowMillis)).expire(key, ttlSeconds).exec());
	}

	async getGlobalCacheLineagePubtimes(globalCache: string, dataIdRaw: string): Promise<string[]> {
		const hash = await this.redis.hgetall(subscriberGlobalCacheLineageKey(globalCache, dataIdRaw));
		return Object.keys(hash);
	}

	async recordGlobalCacheLineagePubtime(globalCache: string, dataIdRaw: string, pubtime: string, nowMillis: number, ttlSeconds: number): Promise<void> {
		const key = subscriberGlobalCacheLineageKey(globalCache, dataIdRaw);
		// PIPELINED, 2026-09-23 -- see recordLineagePubtime's own comment.
		assertPipelineOk(await this.redis.pipeline().hset(key, pubtime, String(nowMillis)).expire(key, ttlSeconds).exec());
	}

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}
