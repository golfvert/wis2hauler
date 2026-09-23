// The Redis-backed persistence the Subscriber pipeline needs, behind
// one narrow interface. Everything in order-links.ts/override.ts/
// prepare.ts/content-id.ts/claim.ts is a pure function over
// already-fetched values (see each file's own header comment) -- this
// is the "already-fetched values come from here" half: the actual
// SETNX/EXISTS/HSET/EXPIRE/XADD/XREAD/DEL calls, kept behind an
// interface so the pipeline orchestration in ingest.ts/consumer.ts can
// be unit tested against a fake in-memory store instead of a live
// Redis Cluster.
//
// Rewritten to match nodered/flows.json's Subscriber tab EXACTLY --
// per the maintainer's "I copied the flows.json in nodered dir in the folder. Do
// exactly what is in flows.json" -- rather than the earlier
// from-scratch design this interface started as. Every method here
// corresponds to one specific Node-RED redis-command node (named in
// each method's own comment); field names, key patterns and TTLs are
// the literal values those nodes' upstream "change" nodes built, not
// a fresh design.
//
// Real implementation: ../redis/ioredis-store.ts (ioredis, single node
// or Cluster per global.redis.mode -- see schema.ts's RedisConfig and
// the maintainer's "I'd like the option of using redis as a cluster or as a
// single node" decision).

export interface RawStreamEntry {
	/** Redis Stream entry ID (e.g. "1694198400000-0"), used to advance the read cursor. */
	id: string;
	topic: string;
	payload: string;
}

export interface SubscriberStore {
	// "Save" -> SET (per-connection, GB1/GB2): SETNX wnmIdDedupKey(wnmId)
	// value "true", EX ttlSeconds (900 in the original -- see the "Save"
	// change node's literal [..., true, "NX", "EX", 900]). true the
	// first time a given wnmId is seen within that TTL window; false for
	// a repeat -- the per-raw-message dedup, ahead of anything
	// content-based. This is separate from the rbe (report-by-exception)
	// step, which ingest.ts applies itself (in-memory, per topic) before
	// ever calling this.
	claimMessageId(wnmId: string, ttlSeconds: number): Promise<boolean>;

	// "Prepare" -> XADD ("wis2gc:mqtt:"+queue): appends a raw ingested
	// message (topic + the untouched wire payload + a millis timestamp)
	// for the XREAD consumer to pick up, approximately trimming the
	// stream to MAXLEN ~ RAW_STREAM_MAXLEN (ioredis-store.ts -- 500000
	// as of 2026-09-21, but see that constant's own doc comment: this
	// is now just a rare backstop, not the primary trim -- that's
	// trimRawStreamBefore below, run periodically off the consumer's
	// own read progress instead of a blind count). Returns the assigned
	// stream entry ID.
	appendRawMessage(queue: string, topic: string, payload: string, timestampMs: number): Promise<string>;

	// "Read" -> XREAD (non-blocking, COUNT 500): reads whatever is
	// available on mqttRawStreamKey(queue) strictly after lastId. NOT a
	// blocking XREAD in the original (no BLOCK argument) -- the polling
	// cadence instead comes from the "Poll" inject node firing every 1s
	// (see run.ts). Empty array when nothing new -- not an error.
	readRawMessages(queue: string, lastId: string, count: number): Promise<RawStreamEntry[]>;

	// "Exists" -> EXISTS downloaderCompleteKey(downloaderId), then
	// "Prepare" -> "SET" (redis-command "Set", 5e3d36a879d79a9a): SETNX
	// downloaderClaimKey(downloaderId) value "true", EX ttlSeconds (900
	// in the original) -- only attempted when the complete check comes
	// back false, matching the original's "Complete ?" switch gating the
	// SET attempt itself out of the already-complete path.
	//
	// COMBINED, 2026-09-23 (previously two separate SubscriberStore
	// methods/round trips, isAlreadyComplete() + claimDownload()) into
	// one EVAL (lua.ts's LUA_CHECK_AND_CLAIM) -- see that script's own
	// doc comment for the full rationale: cutting SUBSCRIBER's
	// per-message Redis round trips on its hot path, and closing the
	// small window that used to exist between the two separate calls.
	checkAndClaimDownload(downloaderId: string, ttlSeconds: number): Promise<{ alreadyComplete: boolean; claimed: boolean }>;

	// "Hset" -> HSET (c12ae5d72cbceb70 / e4d3fac4c6c469c0): HSET
	// downloaderHashKey(downloaderId) "attempt" "1". Used ONLY on the
	// 'publish-only' outcome (global-cache mode + nocache) -- the
	// 'download' outcome sets its own "attempt" field as part of
	// writeDownloadJob's single HSET instead (see the original's
	// 46b244fbdbb29b75 "HSET" node, which folds attempt into the same
	// call as href/wnm/topic/published).
	initAttempt(downloaderId: string): Promise<void>;

	// "HSET" (46b244fbdbb29b75/a34872baa44258e7) + "Expire"
	// (15a590438adf2fbe/b8c8b78c2eb72dc5): the 'download' outcome's job
	// record. HSET downloaderHashKey(downloaderId) <href>="queue"
	// "src:"+href=<source> wnm=<wnmJson> topic=<topic> published=<published>
	// attempt=1, then EXPIRE that key 7200 seconds. The hash FIELD name
	// is the href itself (not a fixed schema name) -- ported exactly as
	// written, odd as that field layout looks.
	//
	// `dataId` (2026-09-20, NOT a port -- added at the maintainer's
	// explicit request while chasing missing data_id: "data_id is the
	// key to identify missing downloads... this is the thread that can
	// be followed from begin to end. downloaderId is only an internal
	// variable"): stored as an EXTRA `data_id` hash field alongside the
	// ported ones above. It's already embedded inside `wnmJson`, but
	// every DOWNLOADER-side call site that fetches this record (the
	// retry-decision 30s-later HGETALL in error-retry.ts chief among
	// them) can now read it straight off the flat record for free,
	// instead of having to JSON.parse `wnm` just to log which message a
	// job is for.
	writeDownloadJob(downloaderId: string, href: string, source: string, wnmJson: string, topic: string, published: string, dataId: string | undefined): Promise<void>;

	// "Queue" -> "XADD" (0bb92d3863dcdad7/54710069ff7a89e7): XADD
	// workQueueStreamKey(queue) * downloader_id=<downloaderId> href=<href>
	// topic=<topic> content=<hasContent>. Hands the job to the
	// Downloader role. Runs in parallel with writeDownloadJob in the
	// original (both fed by the same link-in junction) -- callers should
	// issue both, order doesn't matter.
	//
	// `dataId` (2026-09-20, NOT a port -- see writeDownloadJob's doc
	// comment above, same request): an extra `data_id` field on the
	// work-queue entry itself, so every DOWNLOADER-side log site that
	// reads a queue entry off XREADGROUP (consumer.ts's whole
	// processQueueEntry/decode-write.ts/aria-start.ts chain) has the
	// data_id available immediately, with NO extra Redis round trip --
	// the same reasoning as ../downloader/store.ts's WorkQueueEntry.dataId
	// doc comment.
	enqueueWork(queue: string, downloaderId: string, href: string, topic: string, hasContent: boolean, dataId: string | undefined): Promise<void>;

	// "HSET" (914f3f9e75a3e351/8f1c48c936bd32b5): the 'wait' outcome.
	// HSET downloaderHashKey(downloaderId) <href>="wait" "src:"+href=<source>.
	// Records a losing copy against the SAME hash the winner's
	// writeDownloadJob is populating (no separate waiters key/list in
	// the original -- confirmed against flows.json, not a guess) so the
	// Downloader/Reporter role can later notice it and give this copy
	// its own publish-only outcome once the winning download completes.
	recordWait(downloaderId: string, href: string, source: string): Promise<void>;

	// "Del" -> "Del" (redis-command DEL, e6443f5d3b5503b9): DEL
	// downloaderClaimKey(downloaderId). Releases a claim this copy won
	// but doesn't need to keep (the 'publish-only' outcome: no download
	// is going to happen under this claim, so don't leave it blocking a
	// future real download of the same content).
	//
	// The original's "Del" change node reads `payload.downloader_id` to
	// build this key, but by the time it runs, `payload` is either the
	// republished WNM (which had `wnm.downloader_id` explicitly deleted
	// two rules earlier) or the monitoring CloudEvents object (which
	// never had a downloader_id field at all) -- so `payload.downloader_id`
	// is always undefined there, and the DEL always targets
	// "wis2gc:downloader:downloader_id:undefined", a key that never
	// exists. The claim is therefore never actually released in the
	// original. Per the maintainer's explicit choice when asked about this
	// ("Fix it (recommended)"), this port calls releaseClaim with the
	// REAL downloaderId instead of replicating that bug, and calls it
	// unconditionally (not gated on Pub 1 being configured, which is
	// also how the original's Del branch is wired -- only reachable
	// through the "Pub 1 ?" switch, so a deployment with no PUB1
	// configured would never even attempt the DEL).
	releaseClaim(downloaderId: string): Promise<void>;

	// NOT a port of anything in flows.json -- see lineage.ts's header
	// for the full rationale (the maintainer's own "Sensor Global
	// Cache" tool exposing a spec-violation origins can commit:
	// reusing a data_id across messages without setting rel=update).
	// Returns every pubtime string previously recorded for this
	// (origin centre, raw data_id) pair via recordLineagePubtime below
	// -- empty array if none (i.e. the first time this data_id has
	// been seen from this origin, within the TTL window).
	getLineagePubtimes(originCentreId: string, dataIdRaw: string): Promise<string[]>;

	// NOT a port of anything in flows.json -- see lineage.ts. Records
	// that `pubtime` has now been seen for this (origin centre, raw
	// data_id) pair, refreshing the whole key's TTL to ttlSeconds.
	// nowMillis is stored as the field's value purely for operator
	// debugging (mirrors SCGC's own "WNM" node, which stores $millis()
	// as the hash field's value) -- nothing in this port reads it back.
	recordLineagePubtime(originCentreId: string, dataIdRaw: string, pubtime: string, nowMillis: number, ttlSeconds: number): Promise<void>;

	// NOT a port of anything in flows.json -- see lineage.ts and
	// subscriberGlobalCacheLineageKey's own doc comment (redis-keys.ts)
	// for the full rationale: catching a single Global Cache repeating
	// its OWN publication of a data_id without rel=update, as opposed
	// to several different Global Caches each legitimately relaying the
	// same origin publish once (that case is NOT a duplicate and must
	// never reach this). Keyed by the `global-cache` label on the
	// message itself, NOT the origin centre -- a separate history per
	// GC. Empty array if this (GC, data_id) pair has no prior record.
	getGlobalCacheLineagePubtimes(globalCache: string, dataIdRaw: string): Promise<string[]>;

	// NOT a port of anything in flows.json -- see getGlobalCacheLineagePubtimes above.
	recordGlobalCacheLineagePubtime(globalCache: string, dataIdRaw: string, pubtime: string, nowMillis: number, ttlSeconds: number): Promise<void>;

	// Raw-stream health check, part 1 (NOT a port of anything in
	// flows.json -- added 2026-09-21 alongside RAW_STREAM_MAXLEN's own
	// doc comment (ioredis-store.ts), after a live investigation found
	// appendRawMessage's XADD ... MAXLEN trim silently evicting
	// fully-ingested entries the consumer hadn't read yet, with zero
	// trace anywhere -- see runConsumerLoop's own doc comment for the
	// detection logic this backs). XLEN mqttRawStreamKey(queue) -- the
	// stream's current entry count. Originally checked directly against
	// a fraction of RAW_STREAM_MAXLEN as an early-warning; now (same
	// day, once trimRawStreamBefore became the primary trim) checked
	// AFTER each periodic trim instead, so a length still close to
	// RAW_STREAM_MAXLEN despite just having trimmed everything the
	// margin allows means the consumer is genuinely behind by more than
	// that margin -- not merely "traffic is high", which used to be the
	// permanent steady state under the old count-only design.
	getRawStreamLength(queue: string): Promise<number>;

	// Raw-stream health check, part 2: the ID of the stream's current
	// OLDEST surviving entry (XRANGE mqttRawStreamKey(queue) - + COUNT
	// 1 -- cheap, fetches one entry, not the whole stream), or
	// undefined for an empty stream. runConsumerLoop compares this
	// against its own read cursor (lastId, stream-id.ts's
	// compareStreamIds): if the oldest surviving entry is NEWER than
	// lastId, the region between them existed and was trimmed away by
	// MAXLEN before the consumer ever read it -- a CONFIRMED loss, not
	// a guess, unlike getRawStreamLength above which only ever warns of
	// a risk.
	getRawStreamOldestId(queue: string): Promise<string | undefined>;

	// PRIMARY raw-stream trim as of 2026-09-21 (XTRIM ... MINID ~
	// cutoffId): removes every entry strictly older than `cutoffId`,
	// run periodically by runConsumerLoop off its own read cursor
	// (stream-id.ts's streamIdMinusMs(lastId, marginMs)) instead of
	// XADD's blind MAXLEN -- see RAW_STREAM_MAXLEN's own doc comment
	// (ioredis-store.ts) for why a count-based cap alone wasn't enough.
	// Because `cutoffId` is always derived from lastId minus a margin
	// the consumer is guaranteed to already be ahead of, this can never
	// remove something not yet read -- unlike MAXLEN (kept as a much
	// larger backstop for a genuinely dead consumer), this is
	// structurally safe regardless of how large the margin or how far
	// behind the consumer gets. Returns the number of entries removed.
	trimRawStreamBefore(queue: string, cutoffId: string): Promise<number>;

	// Graceful shutdown of the underlying client(s).
	quit(): Promise<void>;
}
