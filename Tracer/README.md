# wis2hauler-tracer

Trace one `data_id` or `wnm.id` across every `wis2gc-*.log` file a Hauler deployment writes — `Received`/`Filter`/`Decision`/`Duplicate` on SUBSCRIBER, `Aria`/`Ack`/`Correct ?`/`Re-queue`/`Update`/`Output - *`/`Duplicates`/`Poll Error` on DOWNLOADER, across every worker — printed as one chronological narrative instead of a per-file `grep`.

This replaces the manual shell recipe in Hauler's own `docs/configuration-and-roles.md` / the project notes' runbook (`find */logs ... | xargs zgrep ...`) with a single command that:

- walks every worker's `logs/` directory under a given root, recursively;
- transparently reads both plain `.log` files and rotated `.log.gz` archives;
- matches the id **anywhere in the parsed line** — top-level `dataId`/`wnmId`, nested inside the full `wnm` object `Filter` now attaches, inside an `href`, wherever — not just a fixed set of known field names, so it keeps working as Hauler's own log shapes evolve;
- sorts every hit into one chronological timeline, labeled with which role/stage it came from.

## Usage

### Prebuilt binary (no bun install needed on the target machine)

Tracer is versioned and released **independently** of the main wis2hauler binaries, on its own `Tracer/VERSION` file and its own tag (`tracer-YYYY.MM.X`) -- a Tracer-only change ships without needing a bump of the repo-root `VERSION`, and vice versa. To cut a Tracer release:

```sh
bun scripts/bump-version.ts Tracer/VERSION
git add Tracer/VERSION && git commit -m "release(tracer): <tag>" && git push
```

`.github/workflows/release.yml`'s `build-tracer` job then compiles a standalone `wis2hauler-tracer-<platform>` binary for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64` (no musl variant, since unlike the main binary this never runs inside the Docker image; see that job's own comment), and `release-tracer` publishes them as assets on a GitHub Release tagged `tracer-YYYY.MM.X` -- its own release, separate from the main `wis2hauler YYYY.MM.X` one. Download the binary matching where you'll actually run it -- most usefully, directly on a deployment's own host, against its live `logs/` directories, with nothing installed:

```sh
chmod +x wis2hauler-tracer-linux-x64
./wis2hauler-tracer-linux-x64 <data_id-or-wnm-id> --root /path/to/logs
```

### From source

```sh
bun install     # once
bun run src/trace.ts <data_id-or-wnm-id> [options]
```

Options:

- `--root <dir>` — directory to scan (default: current directory). Point this at the parent of every worker's `logs/` directory (e.g. the directory containing `one/`, `two/`, ... `seven/`), or at a single `logs/` directory directly — both work, the walk is recursive.
- `--since <time>` / `--until <time>` — bound the search to a time window (anything `Date` can parse, e.g. `2026-09-20T15:00:00Z`). Files entirely outside a generously padded window are skipped without being opened, for speed on a large log volume; the actual bound is enforced exactly against each line's own UTC `timestamp` field.
- `--json` — print the raw matches as a JSON array (for piping into `jq` or another tool) instead of the human-readable narrative.
- `-h`, `--help` — usage.

### Example

```sh
bun run src/trace.ts wis2/de-dwd-gts-to-wis2/data/core/I/S/X/X/14/EUSR/ISXX14EUSR201219_C_EDZW_20260920160805_54200365 --root ~/Bun/Hauler-deployment
```

```
4 matching log line(s) for "..." -- 4/4 file(s) scanned had a hit:

[2026-09-20T16:08:19.663Z] SUBSCRIBER Received             debug {"bytes":999,...}
[2026-09-20T16:08:19.664Z] SUBSCRIBER Filter               debug {"outcome":"ingested","wnm":{...},...}
[2026-09-20T16:08:20.100Z] DOWNLOADER Ack                  debug {"downloaderId":"wis2:centre:abc",...}
[2026-09-20T16:08:20.100Z] DOWNLOADER Aria                 debug {"gid":"a1b2c3",...}

First seen: Received at 2026-09-20T16:08:19.663Z
Last seen:  Aria at 2026-09-20T16:08:20.100Z -- a real aria2 download was registered (addUri)
```

Reading it, same logic as the manual recipe it replaces: no `Received` line anywhere → the message never reached this replica's broker connection at all (check `mqtt.whitelist` for that centre/topic, or look upstream). A `Received` line but the trail stops there → dropped inside `ingest.ts`'s own filters (`Filter`'s `outcome` says which one). A trail that stops at `Decision` → that line's `action`/`reason` is the answer. Past that, DOWNLOADER's own lines (`Aria`/`Ack`/`Correct ?`/`Re-queue`/`Update`/`Output - Error`/`Poll Error`) tell you where a download attempt actually failed.

One known gap this tool inherits from Hauler itself (documented there too): a download that exhausts every retry (`RETRY_NOK`) has no dedicated log line — `error-retry.ts` only writes that to a Redis stream, never through a `SourceLogger`. If the trace ends with a `Re-queue`/`Update` pair and then nothing, that's the same "probably exhausted retries" inference the manual runbook already relies on, not a bug in this tool.

## How it identifies a log file

Hauler's own `../src/logging/sink.ts` names every file `wis2gc-<slug>-<date-hour>.<level>.log`, gzip-archived on rotation as `...log.gz`. `<slug>` is `slugifySource(name)` from `../src/logging/slug.ts` — lowercase, everything but `a-z` stripped — e.g. `Correct ?` → `correct`, `Re-queue` → `requeue`, `Output - Error` → `outputerror`. `src/sources.ts` in this tool maps each slug back to a readable name/role/stage for the narrative; it's a hand-maintained mirror of `../src/*/run.ts`'s and `../src/main.ts`'s `createSourceLogger(...)` call sites, kept as a by-hand mirror rather than an import even though this now lives inside the same repo — see `src/sources.ts`'s own header comment for why. An unrecognized slug still traces and prints correctly, just with a generic label — update `src/sources.ts` if Hauler adds a new logger.

## Development

```sh
bun test        # src/__tests__/logs.test.ts
bun x tsc --noEmit
```
