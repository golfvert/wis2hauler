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

### `subscriber.weight-sources` / `subscriber.weight-delay-seconds` / `subscriber.weight-delay-max-seconds` — optional (2026-09-20, replaces `priority-global-cache`)

Controls which sources (the true origin, and/or specific Global Cache repeaters) this Subscriber is willing to claim content from, and how the claim race between them is decided when the same content arrives via more than one source.

`weight-sources` is a map from a source key to a non-negative weight:

- The key `origin` refers to `origin/a/wis2/...` traffic (the true origin's own message).
- Any other key is the FULL raw `properties['global-cache']` value a `cache/a/wis2/...` notification carries (e.g. `de-dwd-global-cache`, not a shortened `de-dwd`) — this is a Global Cache repeater relaying that content.

Two default rules govern weight resolution:

1. **`weight-sources` entirely unset** — every source (origin and any recognized cache repeater) gets weight 1. This is the zero-config behavior: everything races on equal footing, matching the old unset-`priority-global-cache` behavior.
2. **`weight-sources` is set (even with just one entry)** — any source not explicitly listed as a key gets weight 0, meaning it is never used at all (treated the same as an unrecognized `global-cache` label always was). **This includes `origin` if it's omitted** — configuring `weight-sources` without an explicit `origin:` entry silently disables all direct-from-origin downloads for every centre. Always list `origin` explicitly once `weight-sources` is used for anything, unless you deliberately mean to exclude it (e.g. a Subscriber whose `mqtt.whitelist` only subscribes to `cache/...` topics for one centre in the first place — see the worked example below).

A source with weight 0 (whether by rule 2's default or an explicit `0`) is discarded outright, before any claim attempt or download — the same as the old priority list's "not in the allowlist" behavior.

**The delay formula.** For any source with weight > 0, the delay before it enters the claim race is drawn randomly:

```
delaySeconds = min( -ln(random()) * (weight-delay-seconds / weight),  weight-delay-max-seconds )
```

The `-ln(random()) * (weight-delay-seconds / weight)` part draws from an **exponential distribution** with mean `mu = weight-delay-seconds / weight`. This has a useful property: when several sources are racing for the same content, each independently drawing a delay this way, the probability that a given source's delay elapses *first* (i.e. it wins the claim) is exactly its share of the total weight across all racing sources — with no coordination between sources needed. A weight of 2 wins roughly twice as often as a weight of 1; a weight of 0.2 loses to a weight of 1 about 5 times out of 6. This is an approximation, not an exact guarantee, since real messages from different sources don't all start their delay clock at the same instant — origin structurally arrives first, since a Global Cache can only republish after receiving from origin — so `weight-delay-seconds` should be set comfortably larger than the typical real arrival-time gap between origin and its mirrors for the approximation to hold well.

An exponential distribution has **no natural upper bound** — the `min(..., weight-delay-max-seconds)` is a hard cap added after a 2026-09-20 production incident (see the "production incident" note below), truncating the rare long draw rather than letting it run arbitrarily high. It's a plain clip, not a re-normalization: for the (by design, rare) fraction of draws that actually hit the cap, the weight-proportional win-share property above stops applying to that fraction specifically (every candidate clipped to the same cap value effectively ties). `weight-delay-max-seconds` defaults to 120 if unset.

**Choosing values — the recipe.** Rather than guessing, work from an operational requirement. Useful facts about an exponential distribution with mean `mu`:

- `P(delay > x) = e^(-x / mu)` — the probability a draw exceeds `x`
- median `= mu * ln(2) ≈ 0.693 * mu`
- the p-th percentile `= -mu * ln(1 - p)` (so the 90th percentile is `mu * ln(10) ≈ 2.3026 * mu`, the 99th is `mu * ln(100) ≈ 4.605 * mu`)

Say your requirement is "a download must complete, including retries and transfer time, within 10 minutes" — which means the initial wait itself needs a tight, known bound. Decide a target percentile and value for your **worst** (lowest-weight) source — e.g. "the 90th percentile of `de-dwd-global-cache`'s wait should be ≤ 60s" — and solve for `mu`:

```
mu = target / ln(1 / (1 - p))        # p=0.9 -> mu = 60 / ln(10) ≈ 26.06s
weight-delay-seconds = mu * weight_min      # weight_min = 0.2 -> ≈ 5.21s
```

Every other, higher-weighted source then automatically gets a *smaller* `mu` (faster), since `mu` is inversely proportional to weight — you only ever need to solve this for the lowest weight in your map. Pick `weight-delay-max-seconds` comfortably above that same target percentile (never below it, or the cap distorts the percentile you just solved for), and sanity-check how often it actually triggers with `e^(-weight-delay-max-seconds / mu)`.

Worked example, matching a real `de-dwd`-focused deployment (a Subscriber whose `mqtt.whitelist` only carries `cache/a/wis2/de-dwd-gts-to-wis2/#` — origin is excluded by the whitelist itself, so it's deliberately left out of `weight-sources` rather than given an `origin: 1` entry):

```yaml
subscriber:
  weight-delay-seconds: 5.2       # solved above: mu(0.2) = 5.2/0.2 = 26s -> P90 ≈ 60s for the worst source
  weight-delay-max-seconds: 120   # hard cap; e^(-120/26) ≈ 1% of de-dwd-global-cache's draws ever reach it
  weight-sources:
    de-dwd-global-cache: 0.2      # DWD's own relay -- likely the same infrastructure as wis2.dwd.de, downweighted
    cn-cma-global-cache: 1
    data-metoffice-noaa-global-cache: 1.5
    jp-jma-global-cache: 1
    kr-kma-global-cache: 1
    sa-ncm-global-cache: 1
```

With these numbers: `de-dwd-global-cache` (weight 0.2, `mu ≈ 26s`) has a median wait around 18s, a 90th percentile around 60s, and virtually never (≈1%) hits the 120s cap. Every other listed source (weight ≥ 1, `mu ≤ 5.2s`) is far faster still (median under 4s, 90th percentile under 12s) and effectively never approaches the cap at all. Any `cache/...` notification whose `global-cache` label isn't one of the six keys above (or is missing the property altogether) is dropped — and since `origin` isn't listed here, so is any `origin/...` notification, which is intentional given this Subscriber's whitelist never subscribes to `origin/...` topics for this centre in the first place.

**Production incident, 2026-09-20**: an earlier rollout of this mechanism (before `weight-delay-max-seconds` existed) used `weight-delay-seconds: 10` with `de-dwd-global-cache: 0.2` (mean delay 50s, unbounded tail) on a Subscriber whose traffic was *entirely* that one centre's content. Combined with a since-fixed bug in `consumer.ts`'s `runConsumerLoop` (it used to block reading the next batch of raw-stream entries on the current batch's delays finishing), the long tail of a handful of unlucky draws stalled the whole consumer loop for minutes at a time — collapsing download throughput for every source on that centre, not just the low-weight one, even though notifications kept arriving on the wire the whole time. Both issues are fixed: the loop no longer blocks reads on delays completing (with a `maxInFlight` backpressure cap as a safety net against unbounded concurrent in-flight entries instead), and `weight-delay-max-seconds` now bounds every delay outright. The recipe above is how to pick values that stay well clear of this failure mode by construction.

### Tracing a missing `data_id` through SUBSCRIBER (2026-09-20)

After the fixes above, some `data_id`s were still reported missing (fewer than before, but not zero). Rather than guess further, SUBSCRIBER's logging was made deep enough to answer *why*, for any specific `data_id`, from the logs alone — no code changes needed to investigate a given case.

**Every log line SUBSCRIBER emits about a message now carries that message's `data_id`** (and usually its raw `wnm.id` too), from the moment it arrives on the wire through to the final download/wait/drop/publish decision. This spans two files/loggers per pipeline stage:

| Stage | Logger (source name) | Log file (when `to: "file"`) | Fires |
| --- | --- | --- | --- |
| `ingest.ts`, arrival | `Received` | `wis2gc-received-*.debug.log` | Unconditionally, for every message that arrives on the wire — before any parsing, so it never has a `data_id`. This is the ground truth for "did anything arrive on this topic at all". |
| `ingest.ts`, per-message outcome | `Filter` | `wis2gc-filter-*.debug.log` | For every one of the five ingest-side outcomes: `unchanged` (rbe), `blacklisted`, `malformed`, `duplicate` (repeat `wnm.id`), `ingested`. Carries `wnmId`/`dataId` whenever the payload was parseable enough to extract them. |
| `consumer.ts`, per-notification decision | `Decision` | `wis2gc-decision-*.debug.log` | For every classified stream entry's outcome: `ignore` (added 2026-09-20 — see below), `already-complete`, `download`, `wait`, `drop`, `publish-only`. Carries `dataId`/`wnmId`/`pubtime`/`href`/`action`, and for `ignore`, the specific `reason` (from `classifyTopic`). |
| `consumer.ts`, data_id lineage | `Duplicate` | `wis2gc-duplicate-*.info.log` | Only when a data_id-reuse-without-`rel=update` duplicate is caught (see the `weight-sources` section above's neighbor, `lineage.ts`). Carries `dataId`/`wnmId`/`pubtime`/`reason`. |

To reconstruct one `data_id`'s whole journey: grep (or run a JSON query over) all four files for that `data_id`, in order of arrival timestamp. If it's genuinely missing end-to-end (no `Received` line at all, on either GB1 or GB2), the message never reached this replica's broker connection — look upstream (the global broker, or the origin/GC never publishing it in the first place). If a `Received` line exists but nothing else does, or the trail stops at a `Filter`/`Decision` entry, that entry's `outcome`/`action`/`reason` is the answer.

**Turning this on: one switch.** `global.log.level: debug` (or a per-role override, `POST /set {"log-level-role": {"role": "SUBSCRIBER", "value": "debug"}}` — see the `global.log` section above) is all that's required for `Received`/`Filter`/`Decision`/`Duplicate` to be fully written, with every `wnmId`/`dataId` field populated — these are all file-routed loggers gated purely by this setting, same as every other structured log in this codebase. `to: "file"` sends them to `wis2gc-<source>-<date-hour>.<level>.log` files as shown in the table above; leave it at the `stdout` default to see the same JSON lines in the container's own log output instead.

There used to be a second, separate runtime toggle (`POST /set {"debug": [...]}`) gating part of `Filter`'s output — removed 2026-09-20 at the maintainer's explicit request ("I'd prefer that debug in log-level is enough to enable all debug. Don't get why this...") in favor of this single switch, matching how every other logger here already worked. That runtime toggle still exists and still affects a separate, older set of plain-text `console.log` lines scattered through this role (pre-existing, unrelated to this tracing effort) — it's not needed for, and doesn't need to be considered for, tracing a `data_id` through the four logs above.

For a dedicated debug build/deployment used specifically to chase a reported-missing `data_id`: set `global.log: {level: "debug", to: "file"}`, restart (or apply it live via the per-role override above), then grep the four log files by the `data_id` in question.

**Is this safe to run everywhere, not just a special debug build?** Yes. `Received`/`Decision`/`Duplicate` were already unconditional before this feature existed — they build a small object and hand it to the logger regardless of level, and the logger itself does one cheap boolean check before deciding whether to actually write. `Filter` follows the same rule for three of its five outcomes (`duplicate`/`ingested`/`malformed`), since the message is already parsed by that point for the pipeline's own sake anyway — logging it is free.

The two outcomes that need care are `unchanged` (rbe) and `blacklisted`: they run *before* this role's own parse, so producing `wnmId`/`dataId` for them means an extra `JSON.parse` of a payload that's about to be discarded regardless — real, avoidable cost if paid on every message at a normal (`info`) log level, on exactly the kind of high-volume path that caused the 2026-09-20 production incident above. That extra parse only happens when the logger itself reports that `global.log.level` (or a per-role override) actually admits `debug` — at any other level it's a single boolean check, nothing more. In short: this is the normal build, safe to run on every replica; the only thing that changes at `log.level: debug` is that you get the full trace, not that anything behaves differently below it.

### The same tracing, extended through DOWNLOADER (2026-09-20)

The trace above stops the moment SUBSCRIBER hands a message off to the work queue — everything DOWNLOADER does with it afterwards (embedded-content decode, the real aria2 download, hash verification, retries) used to be correlatable only by `downloaderId`, an internal hash of the WNM with no relationship to anything an operator would actually be looking for. Per the maintainer: *"data_id is the key to identify missing downloads... this is the thread that can be followed from begin to end. downloaderId is only an internal variable."*

`data_id` is now threaded as its own field the whole way through DOWNLOADER's Redis records too — SUBSCRIBER's `enqueueWork`/`writeDownloadJob` writes it as an extra `data_id` field (alongside the ones already written) on both the work-queue entry and the `downloader_id` hash record, so every DOWNLOADER-side stage picks it up with **no extra Redis round trip**: the work-queue entry (`WorkQueueEntry.dataId`) carries it into `decode-write.ts`/`aria-start.ts`, which write it onward into the `stream_id`/`aria2_gid` records, which `ack.ts`'s `AckedEntry.dataId` reads back — and `error-retry.ts`'s 30-second-later retry decision reads it straight off the `downloader_id` hash record's own new field, no `wnm` JSON parse required.

Every DOWNLOADER-side logger now carries `dataId` (in addition to `downloaderId`, still there for anyone correlating against the Redis key itself): `Aria`, `Ack`, `Correct ?`, `Re-queue`, `Update`, `Duplicates`. Two more things closed at the same time:

- **`Correct ?`'s `HASH_NOK` used to mean two different things with no way to tell them apart** — a genuine digest mismatch, or an unsupported hash method (a config problem, nothing wrong with the download). It now also carries `hashDetail: 'digest-mismatch' | 'unsupported-method'`.
- **A real aria2 download failure (`onDownloadError`) used to log only the gid and `status: 'error'`**, never aria2's own reason. `Output - Error` now also carries `errorCode`/`errorMessage` straight off aria2's `tellStatus` reply.

One more gap: a download that fails before aria2 even accepts it (aria2 unreachable, `addUri` rejected) was previously only ever logged via plain `console.error` — never captured by the file sink regardless of `global.log.to`, since that particular catch block predates this role having any structured logging at all. It's now also mirrored to a new file-backed `Poll Error` logger, with `dataId`/`downloaderId`/`href`, so a download that vanishes at the very first step still leaves a trace on disk.

Same safety story as SUBSCRIBER's: every new field above was either already sitting in an object that gets built regardless of level (the Redis records themselves, and every logger call bar one), or read off a record DOWNLOADER already fetches for its own logic (`error-retry.ts`'s retry decision) — nothing here adds a new unconditional Redis round trip or JSON.parse. Safe to run everywhere, same as before.

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
