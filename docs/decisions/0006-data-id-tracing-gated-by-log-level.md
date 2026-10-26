# 0006. `data_id` tracing, gated by `log.level`

- Status: accepted
- Date: 2026-09-20 (extended 2026-09-21, 2026-10-24)
- Related: commits 2b7b779 (2026.09.16), 6b28fef (2026.09.17), a1c91e8 (2026.09.11), e1c25a6 (Tracer), b088f7f (Reporter); `docs/logging.md`

## Context
Some `data_id`s reported missing by an external "origin messages" tool left no trace in any log, so it was impossible to tell where in the pipeline they were dropped. `downloaderId` was only an internal join key and did not survive across roles.

## Decision
- `data_id` (plus `wnm_id` where available) is carried on every structured log line and stored in the work-queue entry and `downloader_id` hash, at no extra Redis round trip, so SUBSCRIBER and DOWNLOADER traces join on it.
- Previously silent outcomes are now logged: SUBSCRIBER `ignore` with a `reason`, every ingest `Filter` outcome (full WNM attached), DOWNLOADER hash failure detail (`digest-mismatch` vs `unsupported-method`), aria2's `errorCode`/`errorMessage`, and pre-aria2 failures (`Poll Error`).
- `global.log.level: debug` is the only switch. Work that is only needed for debug on a hot path (extra JSON parse in `Received`/`Filter`) is gated by `SourceLogger.debugEnabled()`, so `info` pays one boolean check. A separate runtime toggle was rejected as a second switch.
- Ships in the normal build, no debug branch.
- The Reporter role (b088f7f) adds one outcome line per accepted notification (`cached`, `late`, `failed`, `missed`) at `info`, answering "was it cached in time" without debug.
- The `Tracer/` CLI merges all log files into one chronological narrative per id.

## Consequences
`Received` and `Filter` dominate disk at debug (full WNM). Retention is per hourly file, default 25 files.

## Verification
At the time of the changes: `tsc --noEmit` and `bun test` (up to 526 pass). Not re-run for this reconstruction.
