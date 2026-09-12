// Real CleanerStore + GcStore, backed by ioredis. Reuses
// ./ioredis-store.ts's createRedisConnection() helper for the same
// cluster-or-single-node reason every other real store in this
// project does -- GcStore is the one place that actually branches on
// mode, since the original's "Clean Redis" GC unconditionally calls
// the Cluster-only `redis.nodes('master')` (see ../cleaner/gc.ts's
// header comment).
import { Cluster } from 'ioredis';
import type { RedisConnection } from './ioredis-store.ts';
import type { CleanerStore } from '../cleaner/store.ts';
import type { XreadReply } from '../cleaner/errors.ts';
import type { GcScanNode, GcStore } from '../cleaner/gc.ts';
import { cleanerPendingKey, errorStreamKey, workerCommandStreamKey } from '../wis2/redis-keys.ts';

export class IoredisCleanerStore implements CleanerStore {
	constructor(private readonly redis: RedisConnection) {}

	async dueSweepMembers(zsetKey: string, nowMs: number): Promise<string[]> {
		const reply = await this.redis.call('ZRANGEBYSCORE', zsetKey, '0', String(nowMs));
		return (reply as string[] | null) ?? [];
	}

	async enqueueWorkerCommand(worker: string, action: string, field: string, value: string): Promise<void> {
		await this.redis.call('XADD', workerCommandStreamKey(worker), '*', 'action', action, field, value);
	}

	async removeSweepMembers(zsetKey: string, members: readonly string[]): Promise<void> {
		if (members.length === 0) return;
		await this.redis.call('ZREM', zsetKey, ...members);
	}

	async scheduleCleanup(scoreMs: string, member: string): Promise<void> {
		await this.redis.call('ZADD', cleanerPendingKey(), scoreMs, member);
	}

	async readErrorStream(queue: string, worker: string, lastErrorId: string): Promise<XreadReply | null> {
		// Was raw `.call('XREAD', ...)` -- confirmed against a real Redis
		// (not the fakes the unit tests use) that raw .call() returns
		// XREAD's reply UNWRAPPED (`[streamName, entries]`), not wrapped
		// in the outer per-stream array (`[[streamName, entries]]`) that
		// processErrors()/XreadReply -- and every other real XREAD/
		// XREADGROUP caller in this codebase -- expects. ioredis's own
		// typed .xread() applies the reply transformer that adds the
		// wrapping back; .call() bypasses it. Real-world symptom the maintainer
		// hit: "Poll Errors failed: undefined is not an object
		// (evaluating 'fields.length')", repeating every 5s forever
		// (lastErrorId never advances past the bad parse).
		const reply = await this.redis.xread('COUNT', 100, 'STREAMS', errorStreamKey(queue, worker), lastErrorId);
		return (reply as XreadReply | null) ?? null;
	}

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}

/** One ioredis node (a Cluster master shard, or the single-node connection itself) wrapped as a GcScanNode. */
class IoredisGcScanNode implements GcScanNode {
	constructor(private readonly node: RedisConnection) {}

	async scan(cursor: string, pattern: string, count: number): Promise<[string, string[]]> {
		const reply = (await this.node.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', String(count))) as [string, string[]];
		return reply;
	}

	async inspect(key: string): Promise<{ ttl: number; idle: number; type: string } | null> {
		const pipeline = this.node.pipeline();
		pipeline.ttl(key);
		pipeline.object('IDLETIME', key);
		pipeline.type(key);
		const results = await pipeline.exec();
		if (!results || results.some(([err]) => err)) return null;
		const ttl = results[0]![1] as number;
		const idle = results[1]![1] as number;
		const type = results[2]![1] as string;
		return { ttl, idle, type };
	}
}

export class IoredisGcStore implements GcStore {
	constructor(private readonly redis: RedisConnection) {}

	getScanNodes(): GcScanNode[] {
		if (this.redis instanceof Cluster) {
			return this.redis.nodes('master').map((node) => new IoredisGcScanNode(node as unknown as RedisConnection));
		}
		return [new IoredisGcScanNode(this.redis)];
	}

	async del(key: string): Promise<void> {
		await this.redis.del(key);
	}
}
