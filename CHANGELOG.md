# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/). Versions are `YYYY.M.X` (see `docs/decisions/0011-versioning-yyyy-m-x.md`). Tracer has its own `Tracer/VERSION`.

Entries up to 2026.10.1 were reconstructed on 2026-10-25 from commit messages, so they are terse. Decisions behind them are in `docs/decisions/`. From now on, add an entry with each change.

## [2026.10.2] - unreleased (VERSION not bumped yet)

### Changed
- **`subscriber.mqtt.whitelist` / `blacklist` renamed to `subscribe` / `exclude`** in the config file and in the admin API (`/get`, `/set`). The old names still work, each with a deprecation warning, until the Maintainer removes them; setting both spellings of one key is an error. A `/set` with an old name reports the change under the new key plus a `warnings` entry. See ADR 0012.
- **Log format:** the `Filter` outcome `blacklisted` is now `excluded` (also the ingest stats field). Update any log queries, dashboards and scripts that match `blacklisted`.
- Fixtures, examples and docs use the new names. Tracer's stage descriptions and README follow (Tracer version not bumped).

### Added
- REPORTER logs one outcome line per accepted notification (`cached`, `late`, `failed`, `missed`) to `hauler-reporter-*.info.log`, with `global.cache-deadline` (b088f7f, 98c56a7). See ADR 0006.
- ADRs in `docs/decisions/`, `AGENTS.md`, this changelog.

### Docs
- Docker deployment option in README; fixes to example READMEs (2e46749, c0b1cb0, 2ec2eae, 91a13b0).

## [2026.10.1] - 2026-10-03
### Changed
- Version tags drop the leading zero of the month (`YYYY.M.X`); the bump script also updates `package.json` (7228901).
### Docs
- Example configs updated (06c660e).

## [2026.09.21] - 2026-09-23
### Fixed
- Critical Redis bug: the combined Lua claim script failed with `CROSSSLOT` in cluster mode and stalled downloads; reverted to two calls (d2d81b7). See ADR 0005.

## [2026.09.20] - 2026-09-23
### Changed
- SUBSCRIBER: reduced CPU load via a combined Lua check-and-claim and pipelined Redis writes (3ad32e0). The Lua part was reverted in 2026.09.21.

## [2026.09.19] - 2026-09-22
### Changed
- Raw stream trim now uses `XTRIM MINID` from the consumer cursor as primary; `MAXLEN` is a backstop (c9abbac, follow-up fix 1e8df6e). See ADR 0004.

## [2026.09.18] - 2026-09-21
### Changed
- Larger raw-stream cap, added alerts (07303ad). `maxInFlight` and `weight-delay-max-seconds` appear in the code from 2026.09.15 (see ADR 0003).

## [2026.09.17] - 2026-09-20
### Changed
- Improved logging in the SUBSCRIBER role (6b28fef).

## [2026.09.16] - 2026-09-20
### Changed
- Improved debugging for log level `debug`, including `debugEnabled()` (2b7b779).

## [2026.09.15] - 2026-09-20
### Changed
- Reviewed how the wait between Global Caches is computed; added `weight-delay-max-seconds` and non-blocking consumer batches (1e2b3b5). See ADR 0003.

## [2026.09.14] - 2026-09-20
### Changed
- **Breaking:** `subscriber.priority-global-cache` replaced by `subscriber.weight-sources` and `weight-delay-seconds` (b4b67a1). See ADR 0002.

## [2026.09.13] - 2026-09-19
### Changed
- Better file naming convention for logs (b5f787a).

## [2026.09.12] - 2026-09-18
### Fixed
- Better detection of duplicate `data_id` (5e6d524).

## [2026.09.11] - 2026-09-16
### Changed
- Unified and improved WNM logging (a1c91e8).

## [2026.09.10] - 2026-09-14
### Added
- Option to download only, without publishing a WNM (a75a762).

## [2026.09.9] - 2026-09-13
### Changed
- Delay when handling the aria2 ack (4fcf8df).

## [2026.09.8] - 2026-09-13
### Changed
- Improved debugging feature (45ab114).

## [2026.09.7] - 2026-09-13
### Fixed
- Bug in the use of mqtt.js (4683840).

## [2026.09.6] - 2026-09-13
### Fixed
- Cleaner logic (dce7a3f).

## [2026.09.5] - 2026-09-13
### Fixed
- Dependency fix (6266f7c).

## [2026.09.4] - 2026-09-13
### Fixed
- Dockerfile (727b887).

## [2026.09.3] - 2026-09-13
First full testable version (6772297).

## Before 2026.09.3 (2026-09-12)
Initial commit, README and docs (aa273f7, dd280c6), `-d` CLI flag removed so debug categories are admin-API-only (aebb993), `origin...core` prevented when not a Global Cache (90b3100). Later in September: examples directory (3be3017, 85659bd).

## Tracer (`Tracer/VERSION`, separate releases)
- Tracer added to track `wnm` and `data_id` (e1c25a6), released independently (5cebfaa, d0baf52, 77d1a9b).
- 2026.09.2 (db010e7; an earlier commit c526ee8 mis-typed it as 2029.09.2).
- 2026.09.5: fix in time selection (b6935dc).
