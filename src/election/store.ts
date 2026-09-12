// The Redis-backed persistence the shared election/heartbeat primitive
// needs, behind one narrow interface -- same split as
// ../downloader/store.ts. All three fields live in the single shared
// hash `wis2gc:configuration` (electionHashKey() in
// ../wis2/redis-keys.ts): every replica HSETs its own `<worker>:*`
// fields every 2s (see elect.ts's buildHeartbeatFields), and every
// role's 10s Elect poll HGETALLs the whole hash and HDELs stale
// fields (see elect.ts's findStaleFields). One shared store interface
// for both the heartbeat writer and the per-role elector, since both
// operate on the exact same hash.
//
// Real implementation: ../redis/ioredis-election-store.ts.

export interface ElectionStore {
	/** HGETALL wis2gc:configuration, returned as a flat [field, value, field, value, ...] array (ioredis's own HGETALL shape) for elect.ts's parseElectionHash to consume. Empty array if the hash doesn't exist yet. */
	readElectionHash(): Promise<string[]>;

	/** HSET wis2gc:configuration with the given flat [field, value, ...] pairs -- this replica's own heartbeat fields, built by elect.ts's buildHeartbeatFields. */
	writeHeartbeat(flatFields: readonly string[]): Promise<void>;

	/** HDEL wis2gc:configuration for the given field names (not flat pairs -- just the field names) -- the stale-worker reaping elect.ts's findStaleFields identifies. No-op if the list is empty. */
	deleteFields(fields: readonly string[]): Promise<void>;
}
