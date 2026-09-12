# Configuration file and roles

This document covers every key in the YAML configuration file, the five roles and how they combine on a instance, the always-on heartbeat/leader-election mechanism underneath the singleton roles, and the runtime HTTP admin API.

It replaces the old Node-RED-era `configuration_reference.md`. The overall shape is very similar — this is a faithful behavioral port — but the two systems differ in a few concrete ways, called out inline: this app reads its config from **one YAML file passed as a CLI argument**, not from environment variables (`CONFIGURATION`/`REDIS_URL`) plus a mounted YAML file; Redis connection details live inline under `global.redis` instead of in a `REDIS_URL` env var; and there is no Node-RED admin UI — only the HTTP admin API described at the end of this document.

---

## How configuration works

```bash
bun src/main.ts <configuration.yml>
```

The config file path is a **required positional argument** — there is no default path and no fallback location. At startup, the file is read once, parsed as YAML, and validated (`src/config/validate.ts`, layered on top of a TypeBox structural schema in `src/config/schema.ts`). If validation fails, the process logs every error and warning and exits with status `1` — nothing subscribes, downloads, or serves HTTP until the file is fixed and the process is restarted.

A subset of YAML settings can also be changed at runtime through `POST /set` (and, for replay, `POST /replayer`) without restarting the process — these are marked **runtime-settable** below. A runtime change is **not** written back to the YAML file and is **per-process** (not shared with other instances) — restarting reloads the file's original values. See "Runtime admin API" at the end of this document for the mechanics.

---

## File structure

```yaml
global:          # identity, Redis connection, logging, local MQTT broker(s)
  ...
subscriber:      # global-broker connections and topic filters — required iff SUBSCRIBER is in global.roles
  ...
downloader:      # aria2, file naming/relocation, S3, credentials — required iff DOWNLOADER is in global.roles
  ...
cleaner:         # retention policy — required iff CLEANER is in global.roles
  ...
replayer:        # historical-replay service — required iff REPLAYER is in global.roles
  ...
reporter:        # metrics tuning — optional even when REPORTER is active
  ...
```

An unrecognized top-level key, or an unrecognized key within a recognized section, is a **warning**, not an error — the config still loads. See `fixtures/example.valid.yaml` for a complete worked example, `fixtures/example.cleaner-only.yaml` for a minimal single-role one, and `fixtures/example.invalid.yaml` for one that's deliberately broken.

---

## `global`

### `global.roles` — required

Comma-separated list of roles this instance performs: any combination of `SUBSCRIBER`, `DOWNLOADER`, `CLEANER`, `REPORTER`, `REPLAYER`. Each role listed requires its matching section to be present (`SUBSCRIBER` → `subscriber:`, `DOWNLOADER` → `downloader:`, `REPLAYER` → `replayer:`) — a missing section for an active role is a hard error at startup. `CLEANER` without a `cleaner:` section is only a warning (files simply never get cleaned).

### `global.worker` — required

A unique name for this instance within the shared Redis store. Used throughout Redis key names (e.g. `wis2gc:downloader:worker3:...`) and in the leader-election heartbeat hash. **Must be distinct across every live instance** — two instances sharing a worker name will corrupt each other's queue tracking and election state.

### `global.redis` — required

```yaml
global:
  redis:
    mode: "single" | "cluster"
    nodes: ["host:port", ...]   # exactly one entry in "single" mode; one or more seed nodes in "cluster" mode
    password: "..."             # optional
```

Every role talks to Redis — it's the shared coordination bus and state store — so this is unconditionally required. See [`deployment.md`](deployment.md#single-node-redis-vs-redis-cluster) for the operational trade-off between the two modes.

### `global.queue` — required when `SUBSCRIBER`, `DOWNLOADER`, or `CLEANER` is active

The name of the Redis stream this instance's SUBSCRIBER/DOWNLOADER work-queue reads from and writes to. All instances sharing a `queue` value participate in the same Redis Streams consumer group and process the same backlog; instances with different `queue` values are completely independent of each other.

### `global.log` — required

```yaml
global:
  log:
    level: "info" | "warn" | "debug"   # required. runtime-settable via POST /set {"log-level": "..."}
    to: "stdout" | "file"              # optional, default "stdout" — strictly either/or, never both at once
    size: 200                          # optional, MB per rotated log file, default 200 — plain number, no unit suffix
    number: 25                         # optional, max rotated files kept, default 25
    dir: "./logs"                      # optional, only used when to: "file", default "./logs"
```

`level` is a verbosity ladder, not a severity threshold: `debug` admits everything, `info` admits the least. A **per-role override** on top of the global default can be set at runtime (`POST /set {"log-level-role": {"role": "SUBSCRIBER", "value": "debug"}}`) — useful for turning up verbosity on just one role without drowning every other role's logs. This per-role override has no equivalent in the original Node-RED flow; it's a deliberate addition.

### `global.global-cache` — optional, default `false`

Set `true` when this deployment is operating as a WIS2 Global Cache rather than a local downloader. When `true`, the subscriber applies an extra rule: a message whose `properties.cache` is `false` is still forwarded to the local broker (so other local consumers still see it) but is **not** queued for download — this is what respects a data provider's explicit "don't cache this globally" flag.

### `global.centre-id` — optional

This instance's own WIS2 centre identifier, used as part of the MQTT client id built for every broker connection this process opens (`<centre-id>-<worker>-<label>`, e.g. `<centre-id>-<worker>-GB1`).

### `global.local-broker` — optional

Up to two local MQTT brokers, wired to `PUB1`/`PUB2`, that `SUBSCRIBER`'s publish-only outcomes and `DOWNLOADER`'s completion notifications get republished to. See [`deployment.md`](deployment.md#local-mqtt-brokers-and-publish-only-outcomes). Same broker object shape as `subscriber.global-broker` below (`broker`, `username`, `password`, `version`, `verifycert`). If absent, downloaded files are stored after download and rename (see below) and sits there for further processing (eg. using an external notify)

### `global.http-port` — optional, default `8080`

The port this hauler's one shared HTTP admin server binds to. Always bound, on every instance, regardless of active roles — the admin API (`/get`, `/set`) is never role-gated. 

---

## `subscriber`

Required iff `SUBSCRIBER` is in `global.roles`.

### `subscriber.global-broker` — required

Up to two WIS2 Global Brokers, wired to `GB1`/`GB2`. Messages from GB1 are processed immediately; GB2 messages are deliberately delayed 2 seconds before deduplication, so that when the same notification arrives on both, the GB1 copy wins and the GB2 copy is dropped as a duplicate. If GB1 is unreachable, GB2 still works on its own. Same broker object shape as `global.local-broker`.

### `subscriber.priority-global-cache` — optional

An ordered list of `global-cache` identifiers used to prefer one cache's copy of a file over another's when multiple caches announce the same content. A notification from a cache not on this list is still downloaded — the list only breaks ties between competing sources.

### `subscriber.mqtt.whitelist` — required, runtime-settable

The MQTT topic patterns subscribed to on the global brokers — only messages matching one of these ever reach the download pipeline. Validated against the strict 6-level WIS2 topic grammar (`origin|cache|monitor|+` / `a` / `wis2` / `<centre-id-with-hyphen>|+` / `data|metadata|+` / ...), with `#` only legal as the final level.

### `subscriber.mqtt.blacklist` — optional, runtime-settable

Patterns applied **after** the whitelist, to drop messages once received. Less strictly validated than the whitelist (any mix of alphanumerics, `-`, `/`, `+`, `#`), which is what lets a pattern like `+/+/+/de-dwd-gts-to-wis2/#` block a centre across every topic prefix at once.

### `subscriber.mqtt.overridelist` — optional, runtime-settable

Rules that force a message to publish-only (no download), by topic match and/or by exceeding a `max-length` in bytes — used for content you want republished locally but never actually cached. It is typically used when running as a Global Cache to e.g. limit the size of files being downloaded.

### `subscriber.mqtt.qos` — optional, default `0`

The MQTT QoS every whitelist (and replay) subscription is made at.

### `subscriber.mqtt.global-replay` — optional, runtime-settable via `POST /replayer`

When non-null, an extra `replay/a/wis2/<value>/#` subscription is added. Combined with a `REPLAYER`-triggered replay, is allows getting notification messages that have been missed (See Global Replay feature as defined in WIS2 Guide).

---

## `downloader`

Required if `DOWNLOADER` is in `global.roles`.

### `downloader.aria-secret` / `downloader.aria-url` — required

The `--rpc-secret` aria2 was started with, and its JSON-RPC WebSocket endpoint (`ws://` or `wss://`). One real WebSocket connection is opened and reused for every download this hauler manages.

### `downloader.aria-inqueue` — required

The maximum number of downloads queued or in-flight at once — the main backpressure knob. Once reached, this instance stops pulling new work off the Redis stream until a slot frees up. Typical values for a busy global cache: 100–500; too high overwhelms aria2, too low leaves bandwidth idle.

### `downloader.aria-download` — required

The exact directory aria2 itself writes into (must match `aria2.conf`'s `dir=` — same host, same case). This app's own embedded-content fast path also writes here directly. Several other pieces of the pipeline (the cleaner's eviction sweep, the cache-directory marker used to recognize a locally-cached link) derive from this same value, so it must never be assumed or hardcoded elsewhere — always set it explicitly.

### `downloader.cache-name` — optional (warning if missing)

This cache's own WIS2 identifier, stamped into `properties.global-cache` on every notification this instance publishes after a successful download. 

### `downloader.download-url` — required

The public base URL downloaded files are served from — combined with the stored path (which depends on `rename-to`) to build the `links[0].href` of every published completion notification.

### `downloader.rename-to` — optional

| Value | Behavior |
|---|---|
| `"topic"` | Path derived from the WIS2 topic (centre id stripped, remaining levels become directories). |
| `"date"` | `YYYY/MM/DD/<filename>`. |
| `"s3"` | Uploaded to an S3-compatible bucket instead of local disk — requires `downloader.s3access`. |
| `false` / omitted | Kept in aria2's own download directory with its original name. |

### `downloader.s3access` — required if `rename-to: "s3"`

`url`, `accesskey`, `secretkey`, `bucket` (required), `region` (optional — warning if missing). The bucket must already exist; this app never creates one.

### `downloader.credentials` — optional, also CRUD-manageable via `POST /set`

Per-topic HTTP Basic credentials for authenticated data sources, keyed by a WIS2 topic that starts with `origin/` and carry `recommended` at level 6. Seeded into the shared Redis hash at startup (added-to, not replacing, whatever's already there from other instances or prior runtime changes) and re-synced from Redis every 10 seconds.

---

## `cleaner`

Only meaningful when `CLEANER` is in `global.roles`; a `CLEANER` role without this section is a warning, not an error (files simply accumulate forever).

### `cleaner.keep-in-cache` — required when the section is present

Seconds a downloaded file is kept before deletion. Deletion is triggered by the Redis key associated with the download expiring, so this is a soft target (typically fires within a few seconds of the nominal deadline), not a hard one. A value `<= 0` deletes files almost immediately.

### `cleaner.redis-gc-threshold-seconds` — optional, default `43200` (12h)

How stale a bookkeeping hash has to be before the periodic Redis-side garbage-collection sweep reclaims it. Not present in the original Node-RED flow (which hardcoded 12h) — exposed here as ordinary config, pulled from the same system as everything else, per a deliberate engineering decision rather than a guess about the original's intent.

---

## `replayer`

Required iff `REPLAYER` is in `global.roles`.

### `replayer.global-replay-url` — required

The WIS2-GREP OGC API Processes endpoint this instance POSTs to when a replay is triggered via `POST /replayer`.

---

## `reporter`

Optional even when `REPORTER` is active.

### `reporter.keep-ip-address` — optional

Seconds an IP address is kept in the sliding-window distinct-IP counter behind the Caddy-webhook-driven active-user metric.

---

## Roles in depth

### Scale-out roles: SUBSCRIBER and DOWNLOADER

Every instance carrying `SUBSCRIBER` or `DOWNLOADER` runs concurrently and independently — there's no election or "one active at a time" gating for these two. Coordination happens through Redis Streams consumer groups instead: multiple `DOWNLOADER` instances sharing the same `global.queue` value pull disjoint entries off the same stream and each does its own share of the work. Run as many of these as your throughput needs, limited only by Redis and your downstream bandwidth.

`SUBSCRIBER` and `DOWNLOADER`, when both active on the same instance, share the same `PUB1`/`PUB2` local-broker connections rather than each opening their own (the process's orchestrator, `src/main.ts`, owns opening these once per process). `SUBSCRIBER`'s own `GB1`/`GB2` upstream connections are opened inside a dedicated try/catch, so an unreachable global broker only fails the `SUBSCRIBER` role on that instance, not the whole process.

### Singleton roles: CLEANER, REPORTER, REPLAYER

These three are "active-standby": every instance carrying one of them runs the same election poll and only the currently-elected primary actually does the role's work (schedules file deletions, serves `/reporter/primary`'s 200, answers `POST /replayer`). A non-primary instance's copy of the role sits idle, ready to take over the moment the current primary's heartbeat goes stale. Run more than one instance carrying the same singleton role purely for failover — running many of them doesn't increase throughput the way it does for `SUBSCRIBER`/`DOWNLOADER`.

### The always-on heartbeat and leader election

**Every** instance, regardless of which roles it carries, writes its own heartbeat fields into one shared Redis hash (`wis2gc:configuration`) every **2 seconds** (after an initial 3-second delay): its own worker name, a process UUID, which of the five roles it carries, whether it's running in S3-relocate mode, and — if it carries `SUBSCRIBER` — the topics it's currently subscribed to. This heartbeat has no role gating at all; it's unconditional infrastructure every process participates in.

Each of `CLEANER`, `REPORTER`, and `REPLAYER` separately polls that same shared hash every **10 seconds** and decides its own primary/secondary status: among every instance whose heartbeat is fresher than **8 seconds** old and which flags that role as `true`, the one with the lexicographically lowest process UUID is primary; everyone else (for that role) is secondary. Every poll also reaps (HDELs) the fields of any worker whose heartbeat has gone stale for **60 seconds or more** — any instance finding stale fields deletes them, so this is safe to run concurrently across every instance without coordination.

`CLEANER` additionally derives a cluster-wide `cleaning-needed` flag from the same heartbeat data: cleaning proceeds unless *every* currently-alive `DOWNLOADER`-carrying instance is running in S3-relocate mode (a mixed or all-local-disk fleet always cleans; a fleet with no downloader instances at all also defaults to cleaning, fail-safe).

| Constant | Value |
|---|---|
| Heartbeat write interval | 2s (after an initial 3s delay) |
| Heartbeat "alive" threshold (used for election) | 8s |
| Heartbeat "stale" threshold (fields reaped) | 60s |
| Per-role election poll interval | 10s |

---

## Runtime admin API

Every instance exposes this on `global.http-port` (default `8080`), regardless of active roles. Changes take effect immediately in the running process and are **not** written back to the YAML file — a restart reverts to the file's values. State is **per-process**, not shared across instances (the same as the original Node-RED `global` context was never cross-instance either).

### `GET /get[?key=<name>]`

Without `key`, returns every field the instance's active roles are allowed to see. With `key`, returns just that field (`400` for an unknown key, `403` if the current roles aren't allowed to see it).

| Key | Requires role | Returns |
|---|---|---|
| `process-mode` | any | `"run"` or `"halt"` |
| `log-level` | any | the global default log level |
| `log-level-role` | any | the per-role log-level override map |
| `worker` | any | `global.worker` |
| `queue` | any | `global.queue` |
| `whitelist` / `blacklist` | `SUBSCRIBER` | the active topic lists |
| `global-replay` | any | the active replay topic, or `null` |
| `debug` | any | the dynamically-set debug categories (the `-d` CLI baseline is not reported — it can't change) |
| `credentials` | `DOWNLOADER` | the current in-memory `{topic: {username, password}}` map |

### `POST /set`

Body is a JSON object; any subset of these keys may be present in one request. The response reports what was applied and what wasn't: `{"changes": {"<key>": {"value": ..., "changed": true|false}}, "errors"?: [...]}`.

| Key | Requires role | Effect |
|---|---|---|
| `process-mode` | any | `"halt"` pauses subscribing/downloading without a restart; `"run"` resumes. |
| `log-level` | any | Changes the global default level immediately. |
| `log-level-role` | any | `{"role": "SUBSCRIBER", "value": "debug"}` — per-role override; `value: null` clears it. |
| `whitelist` / `blacklist` | `SUBSCRIBER` | Replaces the active list; brokers re-subscribe in the background. |
| `credentials` | `DOWNLOADER` | `{"op": "create"\|"update"\|"delete", "topic": "...", "username"?: "...", "password"?: "..."}` — applied as a real Redis HSET/HDEL, picked up by every `DOWNLOADER` instance within its next 10s sync. |
| `debug` | any | Replaces the dynamic debug-category set wholesale (e.g. `["SUBSCRIBER", "DOWNLOADER"]`). |

Example — pause a instance for maintenance:

```bash
curl -X POST http://localhost:8080/set -H 'content-type: application/json' \
  -d '{"process-mode": "halt"}'
```

### `POST /replayer` — primary-gated

Only the currently-elected `REPLAYER` primary processes this; every other instance returns `403` immediately. Use `GET /replayer/primary` first to find which one that is.

| Key | Type | Effect |
|---|---|---|
| `global-replay` | string | Sets the replay topic identifier used to build the `replay/a/wis2/<value>/<uuid>/#` subscription. |
| `replay` | `{from, to}` (minutes before now; `to: 0` means "up to now") | Triggers a one-off historical replay for that window. |

### `GET /reporter/primary` / `GET /replayer/primary`

`200` if this instance currently holds that role's election, `404` otherwise — use these to find which instance is actively serving metrics or replay requests.
