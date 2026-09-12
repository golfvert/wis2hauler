// Redis key builders shared across roles (Subscriber today; Downloader/
// Cleaner/Reporter will reuse the downloader_id-scoped ones once
// they're ported). Centralizing these avoids the key-pattern typos
// that are easy to introduce when the same "wis2gc:downloader:..."
// template gets re-typed as a string literal at every call site — the
// original had it inline in a dozen-plus Node-RED change nodes across
// tabs.
//
// Ported field-for-field against nodered/flows.json's Subscriber tab
// (the "Save"/"HSET"/"Expire"/"Queue"/"Read"/"Del" change nodes):
// every key pattern below is the literal JSONata array literal those
// nodes build, not a guess.
export const wnmIdDedupKey = (wnmId: string): string => `wis2gc:subscriber:wnmid:${wnmId}`;

export const downloaderHashKey = (downloaderId: string): string => `wis2gc:downloader:downloader_id:${downloaderId}`;
export const downloaderClaimKey = (downloaderId: string): string => `wis2gc:downloader:set:downloader_id:${downloaderId}`;
export const downloaderCompleteKey = (downloaderId: string): string => `wis2gc:downloader:complete:downloader_id:${downloaderId}`;

export const mqttRawStreamKey = (queue: string): string => `wis2gc:mqtt:${queue}`;

// NOT "wis2gc:"-prefixed -- the original's "Queue" change node builds
// the XADD key as bare $globalContext("queue"), unlike every other
// key here. Confirmed against flows.json node 0bb92d3863dcdad7; kept
// as its own function (rather than inlining config.global.queue
// everywhere) so this asymmetry stays documented at its one call site
// instead of silently relying on callers to remember it.
export const workQueueStreamKey = (queue: string): string => queue;

// -- Downloader-role keys below, ported field-for-field against
// nodered/flows.json's Downloader tab (session tracing of every
// redis-command node's upstream "change" node -- see downloader/store.ts
// for the full per-command citations). --

// "Aria" HSET (720ae80ef0ae827b) / "Map"->HGETALL (0c40f2d437251be2):
// the pre-registration record written before calling aria2.addUri, keyed
// by the stream_id this port mints per in-flight aria2 request.
export const streamIdKey = (worker: string, streamId: string): string =>
	`wis2gc:downloader:${worker}:stream_id:${streamId}`;
export const streamIdExpireKey = (worker: string, streamId: string): string => `${streamIdKey(worker, streamId)}:expire`;

// "Aria2" HSET (0a2911c4385cb16a) / StartAck's HGETALL (673b8c81bcd0d31b):
// promoted once the real gid is known (or written directly by Decode &
// Write for the embedded-content fast path) -- the record StartAck reads
// to XACK/XDEL/clean up the originating work-queue entry.
export const aria2GidKey = (worker: string, gid: string): string => `wis2gc:downloader:${worker}:aria2_gid:${gid}`;
export const aria2GidExpireKey = (worker: string, gid: string): string => `${aria2GidKey(worker, gid)}:expire`;

// "Prepare" (52435883cf148ace): the pub/sub channel the Cleaner/Reporter
// roles listen on for per-download outcome notifications.
export const cleanerReporterKey = (worker: string): string => `wis2gc:cleaner-reporter:${worker}`;

// "Cancel" ZADD/ZREM (fix_cxl_zadd_build / fix_cxl_zrem_build): a single
// shared sorted set (not worker-scoped) tracking in-flight downloads the
// Cleaner role can still cancel, scored by a millis deadline.
export const cleanerCancelKey = (): string => 'wis2gc:cleaner:cancel';

// "Error" XADD (69fecbd2e0adadb4): a capped per-queue-per-worker stream
// of download failures that exhausted retries.
export const errorStreamKey = (queue: string, worker: string): string => `wis2gc:error:${queue}:${worker}`;

// "Credentials" HGETALL (cred-sync-hgetall-build), synced into an
// in-memory topic->{username,password} map every 10s; also the target of
// the Setup tab's one-time startup seed from config.downloader.credentials.
export const downloaderCredentialsKey = (): string => 'wis2gc:downloader:credentials';

// "Info" (b1b5d1a78307d028) -> LUA_HSET_EXPIRE: a per-downloaded-file
// record (uri/length/centreid/topic), EXPIREd 86400s after being written.
export const infoGranuleKey = (uri: string): string => `wis2gc:downloader:info:granule:${uri}`;

// "LastId"/"Read" (ecfec011b1672be5 / 2843374246efbb12): the Cleaner
// role's per-worker command stream (delete/cancel instructions) -- NOT
// "wis2gc:"-prefixed, same bare-name asymmetry as workQueueStreamKey
// above (confirmed against flows.json, not a guess).
export const workerCommandStreamKey = (worker: string): string => worker;

// -- Cleaner/Reporter/Replayer keys below, ported field-for-field
// against nodered/flows.json's Cleaner/Reporter/Replayer tabs. --

// The shared leader-election + heartbeat hash every role-carrying
// replica writes itself into every 2s ("Configuration"/ua_hb_build in
// the Setup tab) and every Cleaner/Reporter/Replayer "Elect" function
// reads (HGETALL) every 10s to decide primary/secondary and reap
// stale (>60s) entries. One shared hash, not role-scoped.
export const electionHashKey = (): string => 'wis2gc:configuration';

// "Schedule" (657fefb1a3a5afae): ZADD target for a file's scheduled
// local-disk deletion time, scored by the millis deadline.
export const cleanerPendingKey = (): string => 'wis2gc:cleaner:pending';

// "Redis"/Lua "Store" (0f4ed7b62cf4aba1 / b4b62b2a4c6e6e27): a sliding
// window ZSET of recently-seen downloader client IPs, used to derive
// the distinct-user-count gauge.
export const reporterActiveIpsKey = (): string => 'wis2gc:reporter:active_ips';

// "HashStat"/"Stats" (0114eaab13d782d9 / a3ff30abf87630d1): 30-second
// time-bucketed counters, curly-brace hash-tagged so the 3 keys for one
// window always land on the same Redis Cluster slot (`multi()`/pipeline
// needs that). windowKey is the "wis2gc:stats:<YYYYMMDDHHmmss>" string
// HashStat mints every 30s (see stats.ts's formatStatsWindow).
export const statsTotalKey = (windowKey: string): string => `{${windowKey}}:total`;
export const statsComboKey = (windowKey: string, centreId: string, subtopic: string): string =>
	`{${windowKey}}:combo:${centreId}:${subtopic}`;
export const statsSrcKey = (windowKey: string, centreId: string, source: string): string =>
	`{${windowKey}}:src:${centreId}:${source}`;
export const statsComboKeyPattern = (windowKey: string): string => `{${windowKey}}:combo:*`;
export const statsSrcKeyPattern = (windowKey: string): string => `{${windowKey}}:src:*`;
