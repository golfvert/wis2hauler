# Source overview

A guided tour of every file under `src/`, for anyone modifying the code. Grouped by directory in the order a request actually flows through the system: entrypoint, then shared infrastructure (config, election, HTTP, logging, MQTT, Redis, WIS2 helpers), then the five role directories.

Test files (`__tests__/*.test.ts`, plus small `fakes.ts` test helpers) aren't described individually — each mirrors the file(s) in its parent directory.

A recurring convention worth knowing up front: almost every file's header comment names the specific Node-RED function node (by tab and node id) it was ported from, and calls out anywhere the TypeScript port deliberately preserves a quirk of the original ("ported field-for-field", "kept, not fixed, per NO GUESS") versus deliberately changes behavior ("DELIBERATE CHANGE" / "BUG FOUND AND FIXED", each with the reasoning). Those node ids and tab names refer to the original Node-RED flow this project was ported from, which isn't part of this repository.

---

## Entrypoint

### `src/main.ts`

The process entrypoint and orchestrator. Parses the CLI (`<config.yaml>`), loads and validates the config, and then owns the whole process's lifecycle:

- Builds the shared `RuntimeConfigStore` (per-process live state backing `GET /get`/`POST /set`) and the log sink.
- Opens the **one** shared HTTP server for the process (always, regardless of active roles) and registers the admin routes on it.
- Opens every MQTT connection this process needs itself, rather than letting each role open its own: `PUB1`/`PUB2` (local broker) once, shared between `SUBSCRIBER` and `DOWNLOADER` when both are active; `GB1`/`GB2` (global broker) inside `SUBSCRIBER`'s own try/catch, so a bad broker only fails that one role.
- Starts every active role's runner concurrently (`Promise.allSettled`, not a sequential chain — an earlier version awaited each role in sequence, which meant a instance combining two roles only ever actually ran the first one), plus the always-on heartbeat.
- Wires a `SIGINT`/`SIGTERM` handler with a bounded 10-second shutdown grace period, so one hung teardown can't make Ctrl-C do nothing.

The `RoleRunners` interface (which every role's `run*` function implements, plus `connectMqtt`/`connectMqttBestEffort`) is what makes this file's own tests possible without dialing real infrastructure: `defaultRunners` wires up the real implementations, and `main.test.ts` swaps in fakes that resolve immediately.

### `src/debug.ts`

`DebugController`: the set of roles currently logging at debug level, controlled entirely through `GET /get?key=debug` / `POST /set {"debug": [...]}`. Replaces two earlier mechanisms that were deliberately removed — a live-reloaded `--debug-file` and, later, a static `-d` CLI flag — so debug toggling now goes through the exact same one live-mutation channel as everything else, with no CLI flag and no file at all.

---

## `src/config/` — loading, schema, validation

### `src/config/schema.ts`

The TypeBox structural schema for the whole YAML file — types, unconditional requiredness, enums, and the handful of genuinely regular patterns (broker URL protocols, `host:port`). Deliberately does **not** try to express role-conditional section requiredness, the WIS2 topic grammar, or warning-vs-error severity in the schema itself — those are business rules, not shape, and live in `validate.ts` instead. Also exports the `VALID_ROLES` list and the `KNOWN_*` key allowlists `validate.ts` uses to warn on unrecognized keys.

### `src/config/validate.ts`

Runs Ajv against `schema.ts`'s shape, then layers hand-written business-rule checks on top: role-conditional section requiredness (`SUBSCRIBER` role → `subscriber:` section must exist), the WIS2 topic grammar (via `topics.ts`), `s3access` required iff `rename-to: "s3"`, and unknown-key detection as warnings. Returns `{valid, errors, warnings, infos}` — errors halt startup, warnings don't.

### `src/config/load.ts`

Reads the file, parses it as YAML, and calls `validate.ts`. Throws `ConfigError` (carrying the full `ValidationResult`) on any parse or validation failure. `parseConfig()` (string in) is split out from `loadConfig()` (path in) so tests can validate a config without touching the filesystem.

### `src/config/runtime.ts`

Validates a `POST /set` patch body against the small live-mutable subset of config: `process-mode`, `log-level`, `log-level-role`, `whitelist`/`blacklist`/`overridelist` (SUBSCRIBER-only), `credentials` (DOWNLOADER-only), `debug`. Reports what would change and why a key was rejected; does **not** itself mutate any live state (that's `admin/runtime-store.ts`'s job) — a deliberate split from the original, which coupled validation directly to Node-RED's global context.

### `src/config/topics.ts`

The WIS2 topic grammar (`isValidMqttTopic`), a looser blacklist/overridelist pattern check (`isValidTopicPattern`), and the credentials-key check (`isValidCredentialTopic`, requiring `recommended` at level 6). Shared by both the static-config validator and the runtime-patch validator — this exact logic was duplicated three times in the original flow; centralized here.

---

## `src/election/` — shared heartbeat and leader election

### `src/election/elect.ts`

The pure decision logic, shared by all three singleton roles: `parseElectionHash` (flat HGETALL array → `{worker: {field: value}}`), `decideElection` (lowest-UUID-among-alive-holders-of-a-role wins primary), `findStaleFields` (which fields to reap), `buildHeartbeatFields` (what a instance writes about itself every tick), and `computeCleaningNeeded` (CLEANER's own extra cluster-wide-S3-awareness rule). Exports the four timing constants: 8s alive threshold, 60s stale threshold.

### `src/election/elector.ts`

The per-role election poll loop (10-second interval) shared by `CLEANER`/`REPORTER`/`REPLAYER`: reads the shared hash, decides this role's primary/secondary status, hands the result to a caller-supplied `onResult`, then reaps stale fields. Each role-carrying instance runs its own independent copy of this loop concurrently.

### `src/election/heartbeat.ts`

The always-on heartbeat writer: one loop per instance process (not per role), writing this instance's own fields into the shared hash every 2 seconds after an initial 3-second delay. Runs regardless of which roles this instance carries.

### `src/election/run.ts`

Top-level wiring for the heartbeat loop: derives this instance's role flags and its currently-subscribed topics (`deriveHeartbeatTopics` — only non-empty on a instance carrying `SUBSCRIBER`) from the config, opens its own Redis connection, and runs `heartbeat.ts`'s loop until the process's shutdown signal fires.

### `src/election/store.ts`

The narrow `ElectionStore` interface (`readElectionHash`/`writeHeartbeat`/`deleteFields`) both the heartbeat writer and every role's elector operate through — all three read/write the one shared `wis2gc:configuration` hash. Real implementation: `redis/ioredis-election-store.ts`.

---

## `src/http/router.ts` — the shared HTTP server

One `Bun.serve()` instance per process, always created (not gated behind any role check), with routes registered onto it by whichever of the admin API, `REPORTER`, and `REPLAYER` are relevant to this instance. Exists because the original Node-RED flow's REPORTER/REPLAYER/admin routes all bound to Node-RED's own single admin server — two independent `Bun.serve()` calls on the same port would otherwise collide.

---

## `src/admin/` — the runtime HTTP admin API

### `src/admin/get.ts`

`GET_FIELDS`: a table of every readable key, each gated by which role(s) may see it (`null` = any role) plus a getter function. `buildGetResponse` is the pure decision (given a key or none, and the active roles, what status and body to return) — kept separate from `routes.ts`'s HTTP framing so it's unit-testable without a real `Request`.

### `src/admin/set.ts`

The `POST /set` half: validates the patch (`config/runtime.ts`), applies the in-memory keys via `RuntimeConfigStore.applyPatch`, and separately applies the two keys that store doesn't own itself — `credentials` (a real Redis HSET/HDEL through the downloader's own store) and `debug` (through `DebugController`) — folding both into the same `{value, changed}` response shape as everything else.

### `src/admin/routes.ts`

Wires `GET /get` and `POST /set` onto the shared `HttpRouter`, and logs one info-level "Change ?" line per key a `/set` request actually changed. `POST /replayer` is **not** here — it lives in `replayer/run.ts` instead, since it needs that role's own election/primary-gate state.

### `src/admin/runtime-store.ts`

`RuntimeConfigStore`: the live, per-process, in-memory state every admin-API read/write operates on — `process-mode`, `log-level` (plus per-role overrides), `whitelist`/`blacklist`/`overridelist`, `global-replay`. Deliberately per-process, matching the original (Node-RED's own `global` context was never shared across instances either). Also implements `LevelGate` (see `logging/logger.ts`), since it's the natural single source of truth for "what level should this role log at right now."

---

## `src/logging/` — structured logging

### `src/logging/logger.ts`

`createSourceLogger(name)` — the one binding point every file wanting leveled, routed logging uses, once, near the top of the file. Checks level admission against a `LevelGate` (resolves an effective level, optionally per-role) before writing anything.

### `src/logging/levels.ts`

The cumulative INFO/WARN/DEBUG admission ladder: `debug` admits everything, `info` admits only info-tagged calls — a verbosity ladder, not a severity threshold.

### `src/logging/sink.ts`

Where a log line actually goes: stdout, or a rotating file (one winston-daily-rotate-file logger per level+source pair, created lazily) — strictly either/or per `global.log.to`, never both.

### `src/logging/from-config.ts`

Translates `config/schema.ts`'s `LogConfig` (the static `global.log` section) into real `WinstonSinkOptions` — the small mapping between "what does this config field mean" and an actual running sink, kept as its own pure function so it's testable without spinning up real winston loggers.

### `src/logging/slug.ts`

`slugifySource(name)`: lowercases and strips non-`[a-z]` characters, for building log filenames — ported verbatim from how the original derived a log filename from whichever node last touched a message.

---

## `src/mqtt/` — MQTT client

### `src/mqtt/types.ts`

`MqttLike`: the narrow MQTT surface the pipeline actually needs (`subscribe`, `onMessage`, `publish`, `end`), kept separate from the real `mqtt.js` client type so the ingest/consumer pipelines can be tested against an in-memory fake broker.

### `src/mqtt/client.ts`

The real `MqttLike`, backed by `mqtt.js`. `connectMqtt` (used for `SUBSCRIBER`'s GB1/GB2, which must fail loudly if unreachable) and `connectMqttBestEffort` (used for `PUB1`/`PUB2`, which must never block startup on an unreachable local broker — always resolves, never rejects) are the two connection primitives `main.ts` calls. Client ids are built as `<centre-id>-<worker>-<label>` so two roles sharing the same local broker never collide on client id (an MQTT broker disconnects whichever connection already held a given client id the moment a second one presents it — a real bug this project hit and fixed by making `main.ts` the sole owner of every connection).

---

## `src/redis/` — Redis-backed store implementations

Each file implements one role's store interface (defined in that role's own directory) against `ioredis`, in whichever mode (`single`/`cluster`) `global.redis.mode` selects.

- **`ioredis-store.ts`** — the shared `createRedisConnection()` helper (branches on `single`/`cluster` once, reused by every other file here) plus the real `SubscriberStore`.
- **`ioredis-downloader-store.ts`** — the real `DownloaderStore`: work-queue XADD/XREADGROUP, the Lua-script-driven hash-record transitions (`downloader/lua.ts`), credentials CRUD.
- **`ioredis-cleaner-store.ts`** — the real `CleanerStore` + `GcStore`; the one file that actually branches explicitly on cluster-vs-single mode, since the original's Redis-GC sweep unconditionally calls a Cluster-only `nodes('master')`.
- **`ioredis-reporter-store.ts`** — the real `ReporterStore`. Notably, its window-stats read can't rely on Redis Cluster hash-tag slot routing the way its writes do (`KEYS <pattern>` has no derivable slot), so it explicitly fans out across every master node in cluster mode rather than hitting one at random.
- **`ioredis-election-store.ts`** — the real `ElectionStore`: a thin HGETALL/HSET/HDEL wrapper around the one shared `wis2gc:configuration` hash.

---

## `src/wis2/` — WIS2 domain types and helpers

### `src/wis2/wnm.ts`

The canonical `Wnm` (WIS2 Notification Message) type, plus `selectLink`/`firstOf` — the "prefer the `update` link, fall back to `canonical`" logic that appeared three separate times in the original flow, now written once. Fields beyond what this codebase actually reads are left as an open index signature rather than fully modeling the WMO WNM schema.

### `src/wis2/topic-match.ts`

MQTT wildcard topic matching (`+`/`#` semantics) and the `replay/a/wis2/...` prefix-stripping applied before matching a replayed message against blacklist/overridelist rules — this exact algorithm appeared three times independently in the original (two blacklist checks, one override check); centralized here.

### `src/wis2/redis-keys.ts`

Every Redis key-name builder shared across roles (`downloaderHashKey`, `downloaderClaimKey`, `downloaderCompleteKey`, `electionHashKey`, and more), so the `wis2gc:...` key templates exist in exactly one place instead of being re-typed as string literals at each call site.

---

## `src/subscriber/` — the SUBSCRIBER role

Ingests WIS2 notifications from GB1/GB2, dedups and filters them, and queues matching ones for download.

- **`ingest.ts`** — the raw MQTT-message-to-stream-entry stage: blacklist filtering, a per-connection SETNX-based dedup (`wnmid`), then XADD onto the shared raw stream. GB1 and GB2 are deliberately asymmetric here (GB2 delays every message 2s; GB1's blacklist gets an extra recommended-topic rule appended in global-cache mode, GB2's doesn't) — both asymmetries are preserved, not "fixed."
- **`order-links.ts`** — reorders a WNM's links (canonical/update first) and computes the per-message randomized delay used before the content-dedup claim race, so that when the same content arrives via multiple paths, each source's share of claimed downloads tracks its configured weight (`subscriber.weight-sources`) rather than a fixed priority order.
- **`content-id.ts`** — derives the content-based `downloader_id` (keyed on integrity hash if present, else publication time) used to dedup a granule across every path it might arrive by.
- **`override.ts`** — the overridelist rules: force publish-only (no download) by topic match and/or size.
- **`prepare.ts`** — derives the "source" label and the combined `nocache` flag (`properties.cache === false` OR an overridelist match) that `claim.ts` and the job-hash record both need.
- **`claim.ts`** — the pure claim decision (already-complete / publish-only / download / wait) given pre-fetched Redis results — the SETNX race and EXISTS check themselves live in `consumer.ts`/`store.ts`, not here.
- **`consumer.ts`** — the XREAD consumer loop: reads raw-stream entries, runs them through `order-links` → `override` → `prepare` → `content-id` → `claim`, and acts on the result (queue a download, publish-only, or drop).
- **`store.ts`** — the `SubscriberStore` interface behind all of the above's actual Redis I/O. Real implementation: `redis/ioredis-store.ts`.
- **`run.ts`** — top-level wiring: subscribes the whitelist on each already-connected GB1/GB2 client (connections themselves are opened by `main.ts`, not here — see its own header comment on that deliberate change), wires messages through `ingest.ts`, and polls the consumer loop every second until shutdown.

---

## `src/downloader/` — the DOWNLOADER role

Pulls queued work, downloads via aria2, verifies, relocates, and republishes completion.

- **`aria2.ts`** — the single real WebSocket JSON-RPC client to aria2, correlating every request/response by JSON-RPC id. Collapses what used to be three separate Node-RED WebSocket connections into one.
- **`aria-start.ts`** — starts one real aria2 download for a given href (the HSET/expire bookkeeping plus the actual `addUri` call and gid registration).
- **`decode-write.ts`** — the embedded-content fast path: when a queued entry already carries its content inline (small payloads), decodes and writes it straight to disk without ever registering a real aria2 download, minting a synthetic gid in the same shape a real one would have. Falls back to the real aria2 path on any decode/integrity failure.
- **`consumer.ts`** — the main loop: pulls queue entries via XREADGROUP, fans each into the embedded-content path or the real-aria2 path, and (via `aria2.ts`'s notification callback) handles aria2's asynchronous completion/error pushes.
- **`ack.ts`** — the common ack/cleanup routine every completed-or-cancelled download runs through, regardless of which of the four possible trigger paths (real completion, real error, embedded-content fast path, cleaner-issued cancel) reached it.
- **`complete.ts`** — reached once a download is ack'd: rebuilds the WNM from the stored hash record, cleans up this attempt's aria2-gid bookkeeping, and runs `hash.ts`'s integrity check.
- **`hash.ts`** — file-integrity verification plus rename/relocate (by date, by topic, or to S3). A genuine filesystem error during relocation is a real thrown `RenameIoError` here (a deliberate behavior change from the original, which let the equivalent error escape uncaught and silently drop the job).
- **`finishing.ts`** — reached only on a successful hash check: transitions the hash record to `complete` and, in four independently try/catch-wrapped steps (a real bug fix — an earlier unwrapped version let one optional step's failure silently skip the other three), republishes the completion notification, marks the dedup-complete flag, publishes cleaner/reporter stats, and records the Caddy-driven info-granule record.
- **`error-retry.ts`** — reached on a bad hash or a real aria2 error: publishes a cleaner-reporter notification, waits 30s, then runs the shared retry decision.
- **`retry.ts`** — the pure retry-decision state machine: given a queue entry's current hash-record state, decide whether another href is worth trying.
- **`lua.ts`** — the two Lua scripts (`LUA_COMPLETE`, `LUA_RETRY`) used for atomic hash-record state transitions, ported character-for-character.
- **`cleaner-ipc.ts`** — a separate 2-second poll (independent from the main consumer loop) that reads delete/cancel commands the CLEANER role writes onto this worker's own command stream.
- **`credentials.ts`** — seeds config-file credentials into Redis once at startup, then keeps an in-memory topic→credential map synced every 10 seconds for `aria-start.ts` to read from.
- **`kv.ts`** — the shared flat-array→object parser used at every HGETALL call site that wants named-field access.
- **`store.ts`** — the `DownloaderStore` interface behind all of the above's Redis I/O. Real implementation: `redis/ioredis-downloader-store.ts`.
- **`run.ts`** — top-level wiring: connects to Redis and aria2, seeds/syncs credentials, and runs the consumer loop and the cleaner-IPC loop concurrently until shutdown. Publishes through the `PUB1`/`PUB2` clients `main.ts` hands it rather than opening its own.

---

## `src/cleaner/` — the CLEANER role

A singleton (elected) role that deletes expired cached files.

- **`gc.ts`** — the periodic (6-hour) Redis-side garbage-collection sweep for stale downloader bookkeeping hashes, independent of file cleanup itself.
- **`schedule.ts`** — schedules a file's future deletion (ZADD into a pending sorted set) off the cache-reporter record `finishing.ts` publishes, honoring `cleaner.keep-in-cache`.
- **`sweep.ts`** — the 2-second poll that finds due entries in both the pending-deletion and cancel sorted sets and turns each into a worker command.
- **`errors.ts`** — a 5-second poll that drains this instance's error stream and logs each entry.
- **`store.ts`** — the `CleanerStore` interface. Real implementation: `redis/ioredis-cleaner-store.ts`.
- **`run.ts`** — top-level wiring: runs election, schedule, sweep, error-polling, and GC concurrently, each gated on this instance currently being the elected CLEANER primary (schedule/sweep additionally gated on the cluster-wide `cleaning-needed` flag).

---

## `src/reporter/` — the REPORTER role

A singleton (elected) role that exposes Prometheus metrics and tracks active users.

- **`kv.ts`** — reshapes the same cache-reporter record `cleaner/schedule.ts` also consumes into named fields (length, delay, centre id, subtopic, source).
- **`route.ts`** — classifies a report as `integrity_fail`, `download_error`, or plain `stats`.
- **`hash-error.ts`** — builds the counter-increment op for an integrity failure or download error. Contains a documented, deliberately-fixed bug from the original (a field reference that never actually resolved, always yielding an undefined centre id).
- **`stats.ts`** — writes windowed per-combo/per-source counters into Redis hashes, each tagged so a Cluster keeps them on one shard.
- **`window.ts`** — a self-scheduling 30-second-aligned window clock that stamps the just-started window for `stats.ts` to write into and hands the just-ended window to `metrics.ts` to aggregate.
- **`metrics.ts`** — reads a closed window's Redis hashes and turns them into Prometheus metric ops.
- **`prom.ts`** — the actual `prom-client` Counter/Gauge registry every metric op above gets applied to.
- **`active-ips.ts`** — a Lua script implementing a sliding-window distinct-IP counter.
- **`caddy.ts`** — the `POST /caddy` webhook handler: parses a Caddy access-log entry, does a GeoIP lookup, and feeds the active-IP counter and per-URI stats.
- **`store.ts`** — the `ReporterStore` interface. Real implementation: `redis/ioredis-reporter-store.ts`.
- **`run.ts`** — top-level wiring: runs election, report processing, and the window clock concurrently, and registers `GET /reporter/primary` + `POST /caddy` on the shared HTTP router.

---

## `src/replayer/` — the REPLAYER role

A singleton (elected) role that replays historical WIS2 notifications on request.

- **`discovery.ts`** — reads the same shared election hash to discover every distinct topic currently subscribed to across the whole deployment (using its own, more generous 60-second alive threshold — deliberately distinct from the 8-second election threshold).
- **`request.ts`** — validates a `POST /replayer` body and turns a `{from, to}` minutes-ago pair into ISO datetime bounds.
- **`replay.ts`** — builds and rate-limits (one request per 10 seconds) the actual outbound replay requests to `replayer.global-replay-url`, one per discovered topic.
- **`run.ts`** — top-level wiring: runs election and registers `GET /replayer/primary` + `POST /replayer` (403 for non-primary instances) on the shared HTTP router. `POST /replayer` writes `global-replay` onto the same `RuntimeConfigStore` instance `GET /get`/`POST /set` use, so a value set here is visible there too, and fires `replay.ts` for an actual `{from, to}` request.

---

## Tests

`src/**/__tests__/*.test.ts` mirrors this structure one-to-one — every pure decision function above has a corresponding test file exercising it directly, and every `run.ts` has a test exercising its wiring against fakes. `src/__tests__/main.test.ts` and `src/__tests__/debug.test.ts` cover the entrypoint and the debug controller. Run the whole suite with `bun test`.
