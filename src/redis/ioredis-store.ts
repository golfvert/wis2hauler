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

// Approximate cap for the raw ingest stream (appendRawMessage's XADD
// MAXLEN below) -- 2026-09-21, raised from 10000 after a live
// investigation traced several wnm.id's whose Filter log showed
// "ingested" (i.e. XADD succeeded) with NO trace of ANY kind
// afterward, not even a Decision "ignore" line -- meaning
// consumer.ts's processEntry was simply never called for them.
// XINFO STREAM on the live deployment that surfaced this
// (wis2gc:mqtt:queue-two) showed `length` pinned at the OLD cap and a
// first-entry/last-entry timestamp spread of ~137 seconds for those
// 10000 entries -- i.e. at that deployment's real ingest rate
// (~73 msg/s onto ONE stream, itself inflated by weight-sources'
// redundancy: every distinct global cache re-mints its own wnm.id for
// the same underlying data_id, so one data_id can produce up to
// len(weight-sources) separate, independently-delayed raw-stream
// entries), the ENTIRE buffer held barely over two minutes of
// history. That's the same order of magnitude as this pipeline's OWN
// intentional worst-case per-message delay
// (subscriber['weight-delay-max-seconds'], a 120s hard cap by
// design -- order-links.ts's computeDelaySeconds) plus
// runConsumerLoop's maxInFlight=5000 backpressure, which pauses
// reading (not writing -- ingest.ts's onMessage handler is never
// gated by consumer state at all) whenever that many entries are
// simultaneously mid-delay. Put together: a burst, a Redis latency
// blip, or simply maxInFlight saturating during a busy hour only
// needs to pause the read loop for about as long as the stream's OWN
// retention window for MAXLEN's approximate trim (XADD ... MAXLEN ~)
// to start silently evicting entries the consumer hasn't read yet --
// no error, no warning, nothing; trimming is a completely ordinary,
// successful Redis operation from Redis's own point of view. Raised
// 10x here (to 100000) to buy a wide margin over that 120s worst-case
// delay even at several times the ingest rate that exposed this --
// cheap in Redis memory (each entry is ~1-2KB) relative to the class
// of bug it prevents (silent, permanent loss of a fully-valid,
// already-parsed notification with no trace anywhere). Deliberately a
// generous buffer, not a tightly "sized to current volume" number --
// volume grows, and this cap failing quietly is exactly the failure
// mode that took a full multi-session trace investigation to find the
// first time.
export const RAW_STREAM_MAXLEN = 100_000;

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

	async isAlreadyComplete(downloaderId: string): Promise<boolean> {
		return (await this.redis.exists(downloaderCompleteKey(downloaderId))) === 1;
	}

	async claimDownload(downloaderId: string, ttlSeconds: number): Promise<boolean> {
		const result = await this.redis.set(downloaderClaimKey(downloaderId), 'true', 'EX', ttlSeconds, 'NX');
		return result === 'OK';
	}

	async initAttempt(downloaderId: string): Promise<void> {
		await this.redis.hset(downloaderHashKey(downloaderId), 'attempt', '1');
	}

	async writeDownloadJob(downloaderId: string, href: string, source: string, wnmJson: string, topic: string, published: string, dataId: string | undefined): Promise<void> {
		const key = downloaderHashKey(downloaderId);
		await this.redis.hset(key, {
			[href]: 'queue',
			[`src:${href}`]: source,
			wnm: wnmJson,
			topic,
			published,
			attempt: '1',
			data_id: dataId ?? '', // see store.ts's doc comment -- NOT a port, an extra field
		});
		await this.redis.expire(key, 7200);
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
		await this.redis.hset(key, pubtime, String(nowMillis));
		await this.redis.expire(key, ttlSeconds);
	}

	async getGlobalCacheLineagePubtimes(globalCache: string, dataIdRaw: string): Promise<string[]> {
		const hash = await this.redis.hgetall(subscriberGlobalCacheLineageKey(globalCache, dataIdRaw));
		return Object.keys(hash);
	}

	async recordGlobalCacheLineagePubtime(globalCache: string, dataIdRaw: string, pubtime: string, nowMillis: number, ttlSeconds: number): Promise<void> {
		const key = subscriberGlobalCacheLineageKey(globalCache, dataIdRaw);
		await this.redis.hset(key, pubtime, String(nowMillis));
		await this.redis.expire(key, ttlSeconds);
	}

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}
