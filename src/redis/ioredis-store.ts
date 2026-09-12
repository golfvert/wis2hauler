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
	wnmIdDedupKey,
	workQueueStreamKey,
} from '../wis2/redis-keys.ts';

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
			10000,
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

	async writeDownloadJob(downloaderId: string, href: string, source: string, wnmJson: string, topic: string, published: string): Promise<void> {
		const key = downloaderHashKey(downloaderId);
		await this.redis.hset(key, {
			[href]: 'queue',
			[`src:${href}`]: source,
			wnm: wnmJson,
			topic,
			published,
			attempt: '1',
		});
		await this.redis.expire(key, 7200);
	}

	async enqueueWork(queue: string, downloaderId: string, href: string, topic: string, hasContent: boolean): Promise<void> {
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

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}
