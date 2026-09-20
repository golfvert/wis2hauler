// The Redis-backed persistence the Downloader pipeline needs, behind
// one narrow interface -- same split as ../subscriber/store.ts:
// consumer.ts/ack.ts/complete.ts/finishing.ts/error-retry.ts/
// credentials.ts/cleaner-ipc.ts (pure orchestration, some of it over
// already-pure decision functions like retry.ts's decideRetry and
// hash.ts's runHash) call these methods; the actual XREADGROUP/HSET/
// EVAL/etc. calls live behind this interface so that orchestration can
// be unit tested against a fake in-memory store instead of a live
// Redis Cluster.
//
// Every method here corresponds to one specific Node-RED redis-command
// (or redis-lua-script) node on the Downloader tab of nodered/flows.json
// (tab id caa031b5574b994f), traced this session node-by-node -- id and
// name cited in each method's own comment, key patterns and field
// layouts taken verbatim from that node's upstream "change" node
// (JSONata `to` expressions), not designed fresh. Per the maintainer's "NO GUESS"
// directive, anywhere the original's wiring was genuinely ambiguous or
// the literal behavior looked accidental, that's called out explicitly
// rather than silently "fixed" or silently replicated without comment.
//
// Real implementation: ../redis/ioredis-downloader-store.ts (ioredis,
// single node or Cluster per global.redis.mode -- reuses
// ../redis/ioredis-store.ts's createRedisConnection helper, the same
// one the Subscriber store already uses, per the maintainer's "remember, option
// of cluster or node" reminder).

/** One entry read off the shared work queue by XREADGROUP, reshaped exactly like the "Href" function node (db2d46c56de8a3d3) reshapes it -- field names match Subscriber's enqueueWork() write (downloader_id/href/topic/content) verbatim, `content` stays the literal "true"/"false" string Subscriber wrote (String(hasContent)), not parsed to boolean. */
export interface WorkQueueEntry {
	/** Redis Stream entry ID (e.g. "1694198400000-0"). */
	id: string;
	downloaderId: string;
	href: string;
	topic: string;
	content: string;
	/**
	 * The WNM's `properties.data_id` -- '' when the original message had
	 * none. NOT a port (2026-09-20): the original's own "Href" reshape
	 * never carried this, and downloaderId (a hash of the WNM, see
	 * content-id.ts) is only an internal correlation key, not something
	 * an operator can grep a specific missing message by. Per the
	 * maintainer: "data_id is the key to identify missing downloads...
	 * this is the thread that can be followed from begin to end.
	 * downloaderId is only an internal variable." Subscriber's
	 * enqueueWork() already writes it as an extra `data_id` field (see
	 * ../subscriber/store.ts's doc comment) specifically so it's
	 * available here with NO extra Redis round trip -- every downstream
	 * log site in this pipeline (decode-write.ts, aria-start.ts,
	 * ack.ts, this file's own consumer.ts) threads it onward from here.
	 */
	dataId: string;
}

/** One entry read off a per-worker command stream (Cleaner role's delete/cancel instructions) by XREAD -- kept as a raw flat field array (not reshaped into a typed object) because this store only ports the Downloader tab; the Cleaner tab that WRITES these entries hasn't been traced, so inventing named fields here would be a guess. cleaner-ipc.ts (not yet written) is responsible for interpreting `fields`. */
export interface WorkerCommandEntry {
	id: string;
	fields: string[];
}

/** The 5 fields every stream_id / aria2_gid hash record carries, ported field-for-field from the "Aria" change node's (0a8b0f2d698dd38b) topic-array build, PLUS `dataId` (2026-09-20, not a port -- see WorkQueueEntry.dataId's doc comment above): carried through from the work-queue entry (real-aria2 path) or the embedded-content entry (decode-write.ts's own matching flatFields build) so ack.ts's AckedEntry -- and everything consumer.ts logs off it -- has the data_id available too, without re-fetching the downloader_id hash record. */
export interface StreamRegistration {
	streamId: string;
	downloaderId: string;
	downloadEntryId: string;
	href: string;
	filename: string;
	dataId: string;
}

export interface DownloaderStore {
	// -- Consumer loop (main 2s poll, "Init" inject 7313f19a0561886b) --

	// "Init" inject sets msg.topic=["STREAM", queue] every 2s (gated by
	// "Ready ?", 4bfd2d6284313475) -> "XINFO" (defc4f68ca99d44f) ->
	// "Values" (fbdbf4e206d546e4) flattens the reply and reads its
	// "length" field (no hyphen-stripping needed for that one field
	// name), defaulting to 0 if absent. Real command: XINFO STREAM
	// <queue>. If the stream doesn't exist yet, real Redis raises a
	// NOSTREAM error rather than returning length 0 -- the original's
	// "XINFO" catch node (67f8462ecddc1ef9) exists specifically to
	// catch that; this port's implementation is expected to catch the
	// same error and return 0, matching the catch node's effect (the
	// "Length ?" gate downstream never sees anything for that tick).
	getQueueLength(queue: string): Promise<number>;

	// "Queue" (f7462c19fdb55dd6) -> "XREADGROUP" (c55b979d0e1b905c):
	// XREADGROUP GROUP <queue> <worker> COUNT <count> STREAMS <queue> ">".
	// The consumer group is named after the queue itself and the
	// consumer after the worker -- group creation (XGROUP) is a Setup-tab
	// concern (node 1b42b9c92f4352df, a different tab), not this store's
	// job -- see ensureWorkQueueGroup() below, which ports that node.
	// Reshaped per entry exactly like "Href" (db2d46c56de8a3d3).
	// Only reached when getQueueLength()'s result satisfies the "Length
	// ?" gate (length > 0 && inQueue < aria-inqueue) -- that gate is
	// in-memory application state (consumer.ts's job), not this store's.
	readWorkQueue(queue: string, worker: string, count: number): Promise<WorkQueueEntry[]>;

	// Setup tab's "Downloader" link-in -> "Queue" (change, b6dda43fbcd85817)
	// -> "XGROUP" (redis-command, 1b42b9c92f4352df):
	// XGROUP CREATE <queue> <queue> $ MKSTREAM -- ported here because it
	// was missing entirely from this rewrite (found 2026-09-11: the maintainer
	// restarted their Mac, which reset their 3-node Redis Cluster to empty,
	// and readWorkQueue() above failed every single poll with "NOGROUP
	// No such key ... or consumer group ... in XREADGROUP" forever --
	// nothing had ever created the stream or the group). MKSTREAM makes
	// this safe to call even when the stream doesn't exist yet (creates
	// it empty, group positioned at "$" i.e. only new entries). Must be
	// idempotent across restarts against a Redis that DID persist its
	// data (AOF/RDB, or simply wasn't restarted) -- the original's XGROUP
	// node has no downstream wiring at all (`wires: [[]]`), so Node-RED
	// just logs a re-run's "BUSYGROUP Consumer Group name already
	// exists" to its own runtime log and moves on; the real
	// implementation is expected to swallow that one specific error the
	// same way and let anything else propagate. Called once at
	// Downloader startup (run.ts), before the consumer loop starts --
	// never gates or blocks it either way, matching the original having
	// no downstream wire to depend on it.
	ensureWorkQueueGroup(queue: string): Promise<void>;

	// -- Downloader hash record (per-message state; keyed by downloader_id) --

	// HGETALL downloaderHashKey(downloaderId). The SAME call, re-issued
	// from scratch every time (never cached) at every one of its 4
	// distinct call sites in the original: "Extract"->HGETALL
	// (da199b792e141f18/b26ce4698f3ba012, feeding "Content ?" before
	// Decode & Write), "Extract"->HGETALL (3f9108575a9461d2/
	// 697aab508a8bb809, feeding the "Next" retry decision -- see
	// ../downloader/retry.ts's decideRetry, whose input is exactly this
	// method's flat-array return value), "Extract"->HGETALL
	// (55d2e511dfb5c291/4917cc0d5ed54eb1, feeding the "Complete" chain's
	// WNM rebuild), and "HGET"->HGETALL (6e26958ea82dc499/
	// 39921dfd1f4e0602, re-fetched again inside the Finishing chain
	// right before "Prepare" builds the cleaner-reporter publish). One
	// method, reused at all 4 call sites -- not 4 separate methods.
	getDownloaderRecord(downloaderId: string): Promise<string[]>;

	// -- Stream-id pre-registration (written just before calling aria2.addUri) --

	// "Aria" (0a8b0f2d698dd38b) -> "HSET" (720ae80ef0ae827b): HSET
	// streamIdKey(worker, streamId) stream_id=<> downloader_id=<>
	// download_entry_id=<> href=<> filename=<>. The pre-registration
	// record read back by getStreamEntry() once aria2 answers addUri
	// with a real gid.
	registerStreamEntry(worker: string, streamId: string, fields: StreamRegistration): Promise<void>;

	// "Expire" (054a152e845015b6) -> a redis-command node NAMED "Expire"
	// whose actual `command` field is "SET" (374ee2dbe63ba0e9), not
	// EXPIRE -- confirmed from flows.json's raw JSON, not assumed from
	// the node's label. SET streamIdExpireKey(worker, streamId) true EX
	// 900 (literal TTL from the change node's JSONata array).
	expireStreamEntry(worker: string, streamId: string): Promise<void>;

	// "Map" (507d242508715d48) -> "HGETALL" (0c40f2d437251be2): HGETALL
	// streamIdKey(worker, streamId). Reads back the pre-registration
	// record once addUri resolves, so its fields can be copied over to
	// the gid-keyed hash by setAria2GidFields().
	getStreamEntry(worker: string, streamId: string): Promise<string[]>;

	// -- aria2_gid promotion (the record StartAck reads to ack the queue entry) --

	// "Aria2" (8e26e398300321ac) -> "HSET" (0a2911c4385cb16a): HSET
	// aria2GidKey(worker, gid) <flatFields>. In the real-aria2 path this
	// is called with whatever getStreamEntry() returned verbatim --
	// the original's own JSONata is `$append([key], payload)`, i.e. a
	// literal copy of the streamId record's flat array under the new
	// gid-keyed name, not a field-by-field rebuild. Also called
	// directly by the embedded-content fast path ("Decode & Write",
	// d76ede1139dcd464), which builds the identical flat-array shape
	// itself (same 5 field names) since it never goes through
	// registerStreamEntry/getStreamEntry at all.
	setAria2GidFields(worker: string, gid: string, flatFields: readonly string[]): Promise<void>;

	// StartAck (link-in bed6957b5bd71319) -> "HGETALL" (673b8c81bcd0d31b):
	// HGETALL aria2GidKey(worker, gid). The caller (a "GID ?" change
	// node at one of 3 call sites -- bb6e6c5527813a68 after
	// onDownloadComplete, e1ccb10b56d9320d after onDownloadError, or
	// 802c136547c2944d from the embedded-content fast path) sets up the
	// key before invoking the "Ack" link-call into StartAck.
	getAria2GidRecord(worker: string, gid: string): Promise<string[]>;

	// -- StartAck's ack/cleanup fan-out (only after the caller's own "First ?"
	// regex check on the fetched record's stream_id passes -- see
	// ../downloader/ack.ts (not yet written), which owns that check; this
	// store has no opinion on when these are called) --

	// "Ack" (f8e71999af77f9db) -> "Ack"/XACK (87c277225ad73c5b): XACK
	// <queue> <queue> <entryId>.
	ackWorkQueueEntry(queue: string, entryId: string): Promise<void>;

	// "Del" (45db458b73681359) -> "XDel" (c2de07c3074e32b9): XDEL
	// <queue> <entryId>. Fanned out in parallel with ackWorkQueueEntry
	// from the same "Ack" change node in the original.
	deleteWorkQueueEntry(queue: string, entryId: string): Promise<void>;

	// "Clean" (345502b5c720830f) -> "DEL" (3ad64eacbd7e7000): DEL
	// streamIdKey(worker, streamId).
	deleteStreamEntry(worker: string, streamId: string): Promise<void>;

	// "Clean" (22a42a503ccaa8b1) -> "DEL" (6873140e784b4ea3): DEL
	// streamIdExpireKey(worker, streamId).
	deleteStreamEntryExpire(worker: string, streamId: string): Promise<void>;

	// "Clean" (cc592c3b63bd0a30) -> "DEL" (0a2dcb9e916b337c): DEL
	// aria2GidKey(worker, gid). Chained sequentially after
	// deleteStreamEntry in the original (Clean->DEL->Clean->DEL->
	// Clean->DEL), but the 3 deletes are independent of each other --
	// ordering, if any, is ack.ts's call to make, not this store's.
	deleteAria2GidRecord(worker: string, gid: string): Promise<void>;

	// "Del" (47d054ac822338de) -> "Del" (7e85da62dad6be3d): DEL
	// aria2GidExpireKey(worker, gid). This is the "Complete" chain's own
	// (redundant/defensive) cleanup, separate from StartAck's -- and per
	// "NO GUESS": no SET/EXPIRE call site for aria2GidExpireKey was ever
	// found anywhere in flows.json's Downloader tab, so this DEL
	// structurally targets a key that (as far as this trace can tell)
	// never gets created. Ported faithfully as a harmless no-op-on-miss
	// DEL rather than inventing a matching SET to "justify" it or
	// silently dropping the call.
	deleteAria2GidExpire(worker: string, gid: string): Promise<void>;

	// -- Cleaner cancel safety-net (a single shared, NOT worker-scoped, sorted set) --

	// "Cancel" (fix_cxl_zadd_build) -> "ZADD" (fix_cxl_zadd): ZADD
	// cleanerCancelKey() <deadlineMs> <worker>|<gid>. deadlineMs is
	// computed internally as Date.now() + 420000 (the literal
	// $millis()+420000, 7 minutes, from the change node's JSONata) --
	// not a caller-supplied parameter, matching how ioredis-store.ts
	// hardcodes its own literal TTLs rather than parameterizing them.
	// Runs immediately after setAria2GidFields() in the real-aria2 path
	// (same HSET's single downstream wire).
	scheduleCleanerCancel(worker: string, gid: string): Promise<void>;

	// "Cancel" (fix_cxl_zrem_build) -> "ZREM" (fix_cxl_zrem_done): ZREM
	// cleanerCancelKey() <worker>|<gid>. Runs in the "Complete" chain
	// right after deleteAria2GidExpire(), once a download has actually
	// finished and no longer needs a cancel safety-net.
	unscheduleCleanerCancel(worker: string, gid: string): Promise<void>;

	// -- Cleaner/Reporter notification channel --

	// "Prepare" (52435883cf148ace) -> "Pub" (fd712bdc50f7b784, command
	// PUBLISH): PUBLISH cleanerReporterKey(worker) <report>. One method
	// serving all 3 call sites that publish to this channel in the
	// original -- the Finishing chain's completion report (via
	// "Prepare"), and the retry-exhausted "Bad hash" (e84fcaddef70ece8)
	// and "Error" (fe79eca7c30f4be3) change nodes, each of which builds
	// its own report string inline before what the original wires as a
	// separate PUBLISH-shaped path. Building the exact report string
	// (JSON-ish array, `$string(...)`-stringified) is the caller's job
	// (finishing.ts / error-retry.ts), not this store's.
	publishCleanerReport(worker: string, report: string): Promise<void>;

	// "Error" (69fecbd2e0adadb4) -> "Error"/XADD (xadd_error_node): XADD
	// errorStreamKey(queue, worker) MAXLEN ~ 1000 * error=<errorPayload>
	// timestamp=<millisString>. Reached only on RETRY_NOK (retry
	// attempts exhausted, or blocked by "error-nocache") -- see
	// ../downloader/retry.ts's decideRetry(). errorPayload is the
	// caller's $string(...)-stringified job record, same as the
	// original.
	recordError(queue: string, worker: string, errorPayload: string): Promise<void>;

	// -- Credentials sync (10s poll, "Every 10s" inject cred-sync-inject) --

	// "HGETALL" (cred-sync-hgetall-build) -> "HGETALL"
	// (cred-sync-hgetall): HGETALL downloaderCredentialsKey(). Returned
	// as the raw flat array; parsing each value as JSON into an
	// in-memory topic->{username,password} map is credentials.ts's job
	// (not yet written), matching the original's "Credentials" function
	// node (cred-sync-update).
	getCredentials(): Promise<string[]>;

	// "Credentials" (cred-config-prep) -> "HSET" (cred-config-hset), Setup
	// tab (1c6759660a32fda5, a DIFFERENT tab from the rest of this file --
	// traced separately since redis-keys.ts's downloaderCredentialsKey doc
	// comment already promised this seed step): HSET
	// downloaderCredentialsKey() <topic1> <json1> <topic2> <json2> ... from
	// config.downloader.credentials, once at startup. A no-op call (no
	// HSET at all) when there are no configured credentials, matching the
	// original's early `if (!creds || ... length === 0) return null;`.
	seedCredentials(entries: Readonly<Record<string, { username: string; password: string }>>): Promise<void>;

	// "Credentials" (02a4f430ad19de4e), Setup tab -- the admin
	// create/update/delete operation on ONE credential entry, previously
	// NOT ported (see credentials.ts's header, which still notes this as
	// out of scope of the Downloader tab's own runtime loop). Now
	// implemented for the GET/SET admin API (../admin/routes.ts): HSET
	// downloaderCredentialsKey() <topic> <json(username,password)>.
	setCredential(topic: string, entry: { username: string; password: string }): Promise<void>;

	// Same admin op, delete branch: HDEL downloaderCredentialsKey() <topic>.
	deleteCredential(topic: string): Promise<void>;

	// -- The 3 EVAL/eval-script calls, from ../downloader/lua.ts --

	// "HGET" (1c95d462b92b83ce) -> "EVAL" (dba76a2231eb7150) running
	// LUA_COMPLETE: EVAL(LUA_COMPLETE, 1, downloaderHashKey(downloaderId),
	// href, storedAtMillis, localHref, localPath). Returns the string
	// "complete" (field existed and is now complete, or already was) or
	// null (Lua false / Redis nil -- the href field didn't exist on the
	// hash at all, which gates the whole Finishing chain off per
	// lua.ts's own header comment). localPath: '' for S3 (nothing to
	// evict) -- see lua.ts's header comment, added 2026-09-13.
	completeHref(downloaderId: string, href: string, storedAtMillis: string, localHref: string, localPath: string): Promise<'complete' | null>;

	// "Update" (051ef2b8332e9716) -> "EVAL" (32d1d4a4cae36be6) running
	// LUA_RETRY: EVAL(LUA_RETRY, 1, downloaderHashKey(downloaderId),
	// promoteHref, promoteSource, newAttempt, errorHref, errorSource).
	// Parameter names match ../downloader/retry.ts's RetryResult fields
	// exactly -- call with a RETRY_OK decision's promoteHref/
	// promoteSource/newAttempt/errorHref/errorSource verbatim. Returns 1
	// if the promotion happened, 0 otherwise.
	retryTransition(
		downloaderId: string,
		promoteHref: string,
		promoteSource: string,
		newAttempt: string,
		errorHref: string,
		errorSource: string,
	): Promise<number>;

	// "Info" (b1b5d1a78307d028) -> "HSET / Lua" (057037c9713eb43f, a
	// redis-lua-script node with keyval:1) running LUA_HSET_EXPIRE:
	// EVAL(LUA_HSET_EXPIRE, 1, infoGranuleKey(uri), "uri", uri, "length",
	// length, "centreid", centreid, "topic", shorttopic). HSETs those 4
	// fields then unconditionally EXPIREs the key 86400s (baked into the
	// Lua script itself, not a parameter here).
	recordInfoGranule(uri: string, length: string, centreid: string, topic: string): Promise<void>;

	// -- Cleaner IPC (a SEPARATE 2s poll from the main consumer loop --
	// driven by its own unnamed inject node, 2d0ae51f574c6fb6, not the
	// "Init"-named 7313f19a0561886b one) --

	// "Read" (2843374246efbb12) -> "XREAD" (83b9019d33a80a1b): XREAD
	// COUNT <count> STREAMS <worker> <lastId>. Non-blocking, same as
	// Subscriber's readRawMessages -- the poll cadence lives in the
	// inject node / run.ts, not a BLOCK argument. The stream key is the
	// bare worker name (workerCommandStreamKey), not "wis2gc:"-prefixed.
	pollCommands(worker: string, lastId: string, count: number): Promise<WorkerCommandEntry[]>;

	// "LastId" (ecfec011b1672be5) -> "Xtrim" (963710c90b7be391): XTRIM
	// <worker> MINID <minId>. Called with the ID of the last entry
	// pollCommands() returned, self-trimming the stream as it's
	// consumed.
	trimCommands(worker: string, minId: string): Promise<void>;

	// -- Finishing chain's completion flag --

	// "Complete" (8da13408293c76fb) -> "Set" (173e41885095af2a): SET
	// downloaderCompleteKey(downloaderId) true EX 21400 (literal TTL
	// from the change node's JSONata array). Marks the whole message
	// (not just this href) as done -- the same key Subscriber's
	// isAlreadyComplete() checks before ever queuing a download.
	markDownloadComplete(downloaderId: string): Promise<void>;

	// Graceful shutdown of the underlying client(s).
	quit(): Promise<void>;
}
