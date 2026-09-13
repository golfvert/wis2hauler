// Real DownloaderStore, backed by ioredis. Reuses
// ../redis/ioredis-store.ts's createRedisConnection() helper for the
// same reason IoredisStore does -- the maintainer's "I'd like the option of
// using redis as a cluster or as a single node" -- so this file has no
// mode-branching of its own; a RedisConnection (Redis | Cluster)
// exposes the same command surface either way.
import type { RedisConnection } from './ioredis-store.ts';
import { LUA_COMPLETE, LUA_HSET_EXPIRE, LUA_RETRY } from '../downloader/lua.ts';
import type { DownloaderStore, StreamRegistration, WorkerCommandEntry, WorkQueueEntry } from '../downloader/store.ts';
import {
	aria2GidExpireKey,
	aria2GidKey,
	cleanerCancelKey,
	cleanerReporterKey,
	downloaderCompleteKey,
	downloaderCredentialsKey,
	downloaderHashKey,
	errorStreamKey,
	infoGranuleKey,
	streamIdExpireKey,
	streamIdKey,
	workerCommandStreamKey,
	workQueueStreamKey,
} from '../wis2/redis-keys.ts';

/** Parses an XINFO/XREAD-shaped "NOSTREAM"/"no such key" error the same way the original's "XINFO" catch node (67f8462ecddc1ef9) absorbs it -- the stream simply hasn't been created yet, so there's nothing to read. */
function isNoStreamError(err: unknown): boolean {
	return err instanceof Error && /no such key|NOSTREAM/i.test(err.message);
}

/** XGROUP CREATE ... MKSTREAM re-run against a group that already exists -- Redis's own idempotency error, expected on every restart against a Redis that persisted its data. */
function isBusyGroupError(err: unknown): boolean {
	return err instanceof Error && /BUSYGROUP/i.test(err.message);
}

export class IoredisDownloaderStore implements DownloaderStore {
	constructor(private readonly redis: RedisConnection) {}

	async getQueueLength(queue: string): Promise<number> {
		let reply: unknown;
		try {
			reply = await this.redis.call('XINFO', 'STREAM', queue);
		} catch (err) {
			if (isNoStreamError(err)) return 0;
			throw err;
		}
		const flat = reply as (string | number)[];
		const idx = flat.indexOf('length');
		if (idx === -1 || idx + 1 >= flat.length) return 0;
		const value = flat[idx + 1];
		return typeof value === 'number' ? value : parseInt(String(value), 10) || 0;
	}

	async readWorkQueue(queue: string, worker: string, count: number): Promise<WorkQueueEntry[]> {
		// Was raw `.call('XREADGROUP', ...)` -- same shape bug as
		// readErrorStream (see ioredis-cleaner-store.ts's comment):
		// confirmed against a real Redis that raw .call() returns
		// XREADGROUP's reply unwrapped, not wrapped in the outer
		// per-stream array this destructure assumes. This was the live
		// Downloader work-queue consumer -- unlike Poll Errors, this
		// would have silently broken every real download (crashing on
		// the very first poll, every poll, forever), just never caught
		// by bun:test since the test suite exercises this against a
		// fake DownloaderStore, not real ioredis.
		const reply = await this.redis.xreadgroup('GROUP', queue, worker, 'COUNT', count, 'STREAMS', queue, '>');
		if (!reply) return [];
		// [[streamKey, [[id, [field, value, ...]], ...]]]
		const [[, entries]] = reply as unknown as [[string, [string, string[]][]]];
		return entries.map(([id, fields]) => {
			const map: Record<string, string> = {};
			for (let i = 0; i < fields.length; i += 2) map[fields[i]!] = fields[i + 1]!;
			return {
				id,
				downloaderId: map.downloader_id ?? '',
				href: map.href ?? '',
				topic: map.topic ?? '',
				content: map.content ?? '',
			};
		});
	}

	async ensureWorkQueueGroup(queue: string): Promise<void> {
		try {
			await this.redis.call('XGROUP', 'CREATE', queue, queue, '$', 'MKSTREAM');
		} catch (err) {
			if (isBusyGroupError(err)) return;
			throw err;
		}
	}

	async getDownloaderRecord(downloaderId: string): Promise<string[]> {
		return flattenHgetall(await this.redis.hgetall(downloaderHashKey(downloaderId)));
	}

	async registerStreamEntry(worker: string, streamId: string, fields: StreamRegistration): Promise<void> {
		await this.redis.hset(streamIdKey(worker, streamId), {
			stream_id: fields.streamId,
			downloader_id: fields.downloaderId,
			download_entry_id: fields.downloadEntryId,
			href: fields.href,
			filename: fields.filename,
		});
	}

	async expireStreamEntry(worker: string, streamId: string): Promise<void> {
		await this.redis.set(streamIdExpireKey(worker, streamId), 'true', 'EX', 900);
	}

	async getStreamEntry(worker: string, streamId: string): Promise<string[]> {
		return flattenHgetall(await this.redis.hgetall(streamIdKey(worker, streamId)));
	}

	async setAria2GidFields(worker: string, gid: string, flatFields: readonly string[]): Promise<void> {
		if (flatFields.length === 0) return;
		await this.redis.hset(aria2GidKey(worker, gid), ...(flatFields as string[]));
	}

	async getAria2GidRecord(worker: string, gid: string): Promise<string[]> {
		return flattenHgetall(await this.redis.hgetall(aria2GidKey(worker, gid)));
	}

	async ackWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		await this.redis.xack(queue, queue, entryId);
	}

	async deleteWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		await this.redis.xdel(workQueueStreamKey(queue), entryId);
	}

	async deleteStreamEntry(worker: string, streamId: string): Promise<void> {
		await this.redis.del(streamIdKey(worker, streamId));
	}

	async deleteStreamEntryExpire(worker: string, streamId: string): Promise<void> {
		await this.redis.del(streamIdExpireKey(worker, streamId));
	}

	async deleteAria2GidRecord(worker: string, gid: string): Promise<void> {
		await this.redis.del(aria2GidKey(worker, gid));
	}

	async deleteAria2GidExpire(worker: string, gid: string): Promise<void> {
		await this.redis.del(aria2GidExpireKey(worker, gid));
	}

	async scheduleCleanerCancel(worker: string, gid: string): Promise<void> {
		await this.redis.zadd(cleanerCancelKey(), Date.now() + 420000, `${worker}|${gid}`);
	}

	async unscheduleCleanerCancel(worker: string, gid: string): Promise<void> {
		await this.redis.zrem(cleanerCancelKey(), `${worker}|${gid}`);
	}

	async publishCleanerReport(worker: string, report: string): Promise<void> {
		await this.redis.publish(cleanerReporterKey(worker), report);
	}

	async recordError(queue: string, worker: string, errorPayload: string): Promise<void> {
		await this.redis.xadd(errorStreamKey(queue, worker), 'MAXLEN', '~', 1000, '*', 'error', errorPayload, 'timestamp', String(Date.now()));
	}

	async getCredentials(): Promise<string[]> {
		return flattenHgetall(await this.redis.hgetall(downloaderCredentialsKey()));
	}

	async seedCredentials(entries: Readonly<Record<string, { username: string; password: string }>>): Promise<void> {
		const pairs = Object.entries(entries);
		if (pairs.length === 0) return;
		const flat: string[] = [];
		for (const [topic, val] of pairs) flat.push(topic, JSON.stringify(val));
		await this.redis.hset(downloaderCredentialsKey(), ...flat);
	}

	async setCredential(topic: string, entry: { username: string; password: string }): Promise<void> {
		await this.redis.hset(downloaderCredentialsKey(), topic, JSON.stringify(entry));
	}

	async deleteCredential(topic: string): Promise<void> {
		await this.redis.hdel(downloaderCredentialsKey(), topic);
	}

	async completeHref(downloaderId: string, href: string, storedAtMillis: string, localHref: string, localPath: string): Promise<'complete' | null> {
		const result = await this.redis.eval(LUA_COMPLETE, 1, downloaderHashKey(downloaderId), href, storedAtMillis, localHref, localPath);
		return result === 'complete' ? 'complete' : null;
	}

	async retryTransition(
		downloaderId: string,
		promoteHref: string,
		promoteSource: string,
		newAttempt: string,
		errorHref: string,
		errorSource: string,
	): Promise<number> {
		const result = await this.redis.eval(
			LUA_RETRY,
			1,
			downloaderHashKey(downloaderId),
			promoteHref,
			promoteSource,
			newAttempt,
			errorHref,
			errorSource,
		);
		return Number(result) || 0;
	}

	async recordInfoGranule(uri: string, length: string, centreid: string, topic: string): Promise<void> {
		await this.redis.eval(LUA_HSET_EXPIRE, 1, infoGranuleKey(uri), 'uri', uri, 'length', length, 'centreid', centreid, 'topic', topic);
	}

	async pollCommands(worker: string, lastId: string, count: number): Promise<WorkerCommandEntry[]> {
		// Was raw `.call('XREAD', ...)` -- same shape bug as
		// readErrorStream/readWorkQueue above.
		const reply = await this.redis.xread('COUNT', count, 'STREAMS', workerCommandStreamKey(worker), lastId);
		if (!reply) return [];
		const [[, entries]] = reply as unknown as [[string, [string, string[]][]]];
		return entries.map(([id, fields]) => ({ id, fields }));
	}

	async trimCommands(worker: string, minId: string): Promise<void> {
		await this.redis.call('XTRIM', workerCommandStreamKey(worker), 'MINID', minId);
	}

	async markDownloadComplete(downloaderId: string): Promise<void> {
		await this.redis.set(downloaderCompleteKey(downloaderId), 'true', 'EX', 21400);
	}

	async quit(): Promise<void> {
		await this.redis.quit();
	}
}

/** ioredis's hgetall() already returns a Record<string,string> -- flattened back to the field,value,field,value... array shape every "K/V"-style function node in the original operates on (see e.g. retry.ts's decideRetry(), which scans that flat shape exactly like the "Next" function node does), rather than porting those functions to take an object and diverge from their literal source. */
function flattenHgetall(record: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(record)) {
		out.push(k, v);
	}
	return out;
}
