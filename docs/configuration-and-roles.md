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

Omitting it entirely is a perfectly normal deployment shape, not a degraded one — it's flagged exactly once, as a startup warning (`global.local-broker: missing or empty — no local MQTT broker configured (PUB1/PUB2 will not connect)`), not re-logged on every message. With no `PUB1`/`PUB2` connected, `SUBSCRIBER`'s own republish step still has nothing to iterate over (unchanged); `DOWNLOADER`'s completion side goes further (since 2026-09-14) and skips preparing the cache-topic WNM at all, not just publishing it — see `finishing.ts`. Either way, every notification and every completed download still processes exactly as it otherwise would, just silently skipping the republish, with no per-message log line marking the skip. With no local-broker configured, `downloader.download-url` becomes optional too — see that field below.

### `global.http-port` — optional, default `8080`

The port this hauler's one shared HTTP admin server binds to. Always bound, on every instance, regardless of active roles — the admin API (`/get`, `/set`) is never role-gated. 

---

## `subscriber`

Required iff `SUBSCRIBER` is in `global.roles`.

### `subscriber.global-broker` — required

Up to two WIS2 Global Brokers, wired to `GB1`/`GB2`. Messages from GB1 are processed immediately; GB2 messages are deliberately delayed 2 seconds before deduplication, so that when the same notification arrives on both, the GB1 copy wins and the GB2 copy is dropped as a duplicate. If GB1 is unreachable, GB2 still works on its own. Same broker object shape as `global.local-broker`.

### `subscriber.priority-global-cache` — optional, unlimited length

An ordered list of `global-cache` identifiers. Once this is set (non-empty), it works as an **allowlist** for `cache/a/wis2/...` traffic, not just a tie-breaker: a `cache` topic notification whose `properties['global-cache']` value isn't in the list — or is missing the property altogether — is discarded outright, before any claim attempt or download. `origin/a/wis2/...` traffic (the true origin's own message, never a repeated copy) is never filtered by this list; there is no `global-cache` value to check on it.

For a centre that *is* listed, its position controls how long this Global Cache waits before entering the claim race for that content, relative to other listed centres — earlier in the list means it tries to claim sooner, so a preferred source's copy is more likely to win when the same content arrives via more than one cache. Position 0 and 1 both wait 1 second; from position 2 onward the wait grows by 1 second per position (3s, 4s, 5s, 6s, 7s, 8s, 9s, 10s, ...) with no upper bound — the list itself is not length-limited (an earlier Node-RED version of this flow was capped at 8 entries by a Switch node's fixed number of outputs; that was a wiring limitation, not a rule, and isn't reproduced here).

Leaving `priority-global-cache` unset (or empty) turns this off entirely: every `cache/a/wis2/...` notification is then treated the same as an origin message — processed immediately, no allowlist filtering, no stagger delay.

Example:

```yaml
subscriber:
  priority-global-cache:
    - gb1-global-cache
    - gb2-global-cache
    - gb3-global-cache
```

A notification with `global-cache: gb1-global-cache` waits 1s before claiming; `gb2-global-cache` also waits 1s; `gb3-global-cache` waits 3s; any `cache/...` notification whose `global-cache` isn't one of these three (or doesn't have one at all) is dropped.

### `subscriber.mqtt.whitelist` — required, runtime-settable

The MQTT topic patterns subscribed to on the global brokers — only messages matching one of these ever reach the download pipeline. Validated against the strict 6-level WIS2 topic grammar (`origin|cache|monitor|+` / `a` / `wis2` / `<centre-id-with-hyphen>|+` / `data|metadata|+` / ...), with `#` only legal as the final level.

### `subscriber.mqtt.blacklist` — optional, runtime-settable

Patterns applied **after** the whitelist, to drop messages once received. Less strictly validated than the whitelist (any mix of alphanumerics, `-`, `/`, `+`, `#`), which is what lets a pattern like `+/+/+/de-dwd-gts-to-wis2/#` block a centre across every topic prefix at once.

### `subscriber.mqtt.overridelist` — optional, runtime-settable

A list of rules that force a matching message to **publish-only** (no download attempt at all — this Global Cache still republishes the notification on `cache/...`, it just never fetches and caches the file itself). Use it for content you're willing to relay but don't want to actually store: known-oversized files, a noisy/experimental data stream, anything you'd rather leave to another Global Cache.

Each rule is a YAML mapping, and every rule needs at least one of these two keys (a rule with neither is ignored):

| Key | Type | Meaning |
|---|---|---|
| `topic` | string | An MQTT-wildcard topic pattern (`+` = exactly one level, `#` = that level and everything after, only legal as the last level). Matched against the message's real topic — a `replay/a/wis2/<centre>/<uuid>/...` wrapper is stripped first, so one rule covers both live and replayed messages. Same alphanumeric/`-`/`+`/`#`/`/` character set as `blacklist`. |
| `max-length` | number | A size ceiling in bytes. The rule matches when the WNM's own declared link length is **strictly greater** than this value. Compared against the size the notification *claims* (`links[].length` on the selected link — `rel: update`, falling back to `rel: canonical`), not the actual downloaded file size, since this decision happens before any download is attempted. A message with no declared length can never match a `max-length` rule. |

Rules are checked in order and the **first match wins**. If a rule sets **both** `topic` and `max-length`, they're ANDed — the topic must match *and* the file must exceed the size ceiling for that rule to fire; put them in separate rules if you want either condition to trigger on its own.

A matching rule always forces the publish-only outcome and republishes the WNM. It additionally emits a WIS2 "Data granule not cached" monitoring event *unless* the origin had already declared `properties.cache: false` on the message itself (in that case there's nothing new to report — the origin already said not to cache it). The event's `description` is filled in from whichever rule matched:

- topic match: `The topic matches a rejected value ( <rule.topic> ) for this Global Cache`
- size match: `The file size is larger than <rule['max-length']> bytes`

Examples:

```yaml
subscriber:
  mqtt:
    overridelist:
      # Topic-only: never download anything under this path, regardless of size.
      - topic: "origin/a/wis2/ca-eccc-msc/data/recommended/atmospheric-composition/experimental/#"

      # Size-only: applies across every topic — any file over 50 MB is publish-only.
      - max-length: 52428800

      # Both keys on one rule = AND: only large files on this specific topic are skipped;
      # smaller files under the same topic still download normally.
      - topic: "origin/a/wis2/de-dwd-gts-to-wis2/data/core/+/+/+/+/#"
        max-length: 10485760
```

Also settable at runtime without a restart, via `POST /set` (`SUBSCRIBER` role required) — see "Runtime admin API" below. This **replaces the whole list**, so include every rule you want active, not just the one you're adding:

```bash
curl -X POST http://localhost:8080/set -H 'content-type: application/json' \
  -d '{"overridelist": [{"topic": "origin/a/wis2/ca-eccc-msc/data/recommended/atmospheric-composition/experimental/#"}]}'
```

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

The exact directory aria2 itself writes into (must match `aria2.conf`'s `dir=` — same host, same case). This app's own embedded-content fast path also writes here directly. `decode-write.ts`, `consumer.ts`'s real-aria2 completion gate, and `cleaner-ipc.ts`'s delete-path reconstruction all derive from this same value, so it must never be assumed or hardcoded elsewhere — always set it explicitly. This worker's own `hash.ts` also uses it (added 2026-09-13) to compute each completed download's path *relative* to this directory, published alongside the cache-reporter record as `local-path`; the elected CLEANER instance reads that field back verbatim to know what to schedule for eviction, rather than re-deriving it from a fleet-wide `"downloads/"` naming convention — which the original flows.json Schedule node assumes, safely, only because it only ever ran inside Docker containers that all mounted this directory under that exact name. A bare-metal deployment has no such guarantee, so this port can't make that assumption either.

### `downloader.cache-name` — optional (warning if missing)

This cache's own WIS2 identifier, stamped into `properties.global-cache` on every notification this instance publishes after a successful download. 

### `downloader.download-url` — required only when `global.local-broker` is configured

The public base URL downloaded files are served from — combined with the stored path (which depends on `rename-to`) to build the `links[0].href` of the cache-topic WNM `DOWNLOADER` republishes to `PUB1`/`PUB2` on a successful download.

Optional since 2026-09-14: with no `global.local-broker` configured at all, there's nothing to republish that WNM to, so `finishing.ts`'s whole "build the cache WNM" step is skipped outright (not just left with nothing to iterate over, the way an empty `local-broker` already behaved) — and `download-url` has no remaining use, so it can be omitted too. Validation reflects the pairing: omitting `download-url` while `local-broker` *is* configured is still an error (there'd be a broker to publish to but no way to build the link), while omitting both together is silent.

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
| `debug` | any | the currently-set debug categories |
| `credentials` | `DOWNLOADER` | the current in-memory `{topic: {username, password}}` map |

`overridelist` is settable (see the `POST /set` table below) but not currently readable back through `GET /get` — `?key=overridelist` returns `400` (unknown key), a gap in this table's counterpart on the get side, not a rule against it. Until that's added, the only way to confirm what's active is whatever you last `POST`ed (or the static YAML, if it hasn't been patched at runtime).

### `POST /set`

Body is a JSON object; any subset of these keys may be present in one request. The response reports what was applied and what wasn't: `{"changes": {"<key>": {"value": ..., "changed": true|false}}, "errors"?: [...]}`.

| Key | Requires role | Effect |
|---|---|---|
| `process-mode` | any | `"halt"` pauses subscribing/downloading without a restart; `"run"` resumes. |
| `log-level` | any | Changes the global default level immediately. |
| `log-level-role` | any | `{"role": "SUBSCRIBER", "value": "debug"}` — per-role override; `value: null` clears it. |
| `whitelist` / `blacklist` | `SUBSCRIBER` | Replaces the active list; brokers re-subscribe in the background. |
| `overridelist` | `SUBSCRIBER` | Replaces the active rule list wholesale — see `subscriber.mqtt.overridelist` above for the rule shape. Include every rule you want kept, not just the one being added or changed. |
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
