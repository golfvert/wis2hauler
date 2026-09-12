// Real ElectionStore, backed by ioredis. Reuses
// ./ioredis-store.ts's createRedisConnection() helper for the same
// cluster-or-single-node reason every other real store in this
// project does.
import type { RedisConnection } from './ioredis-store.ts';
import type { ElectionStore } from '../election/store.ts';
import { electionHashKey } from '../wis2/redis-keys.ts';

export class IoredisElectionStore implements ElectionStore {
	constructor(private readonly redis: RedisConnection) {}

	async readElectionHash(): Promise<string[]> {
		const reply = await this.redis.call('HGETALL', electionHashKey());
		return (reply as string[] | null) ?? [];
	}

	async writeHeartbeat(flatFields: readonly string[]): Promise<void> {
		if (flatFields.length === 0) return;
		await this.redis.call('HSET', electionHashKey(), ...flatFields);
	}

	async deleteFields(fields: readonly string[]): Promise<void> {
		if (fields.length === 0) return;
		await this.redis.call('HDEL', electionHashKey(), ...fields);
	}
}
