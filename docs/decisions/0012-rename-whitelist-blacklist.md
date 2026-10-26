# 0012. Rename `whitelist` / `blacklist` to `subscribe` / `exclude`

- Status: accepted
- Date: 2026-10-26
- Related: ADR 0002, 0006; `src/config/schema.ts`, `src/config/validate.ts`, `src/config/runtime.ts`, `src/admin/*`; Deployment `validate-config.sh`

## Context
`subscriber.mqtt.whitelist` (topics to subscribe to) and `subscriber.mqtt.blacklist` (topics dropped even if they match the whitelist) use terms the Maintainer wants replaced by `subscribe` and `exclude`, which say what the lists do.

Impact found by searching both repos on 2026-10-26:
- **Config schema/validation:** `schema.ts` (keys and `KNOWN_SUBSCRIBER_MQTT`), `validate.ts` (messages), `subscriber/run.ts`, `election/run.ts`, `admin/runtime-store.ts`.
- **Admin HTTP API (external):** `GET /get?key=whitelist|blacklist`, `POST /set {"whitelist": ...}` / `{"blacklist": ...}`, and the `Change ?` log line that records the key.
- **Internal names:** `isBlacklisted()`, `effectiveBlacklist`, `*_BLACKLIST_RULE` constants, `getWhitelist()`/`getBlacklist()`, comments; about 25 source files, 10 test files.
- **Log vocabulary:** the `Filter` outcome value `blacklisted` and the ingest stats field of the same name, plus `docs/logging.md`, `Tracer/src/sources.ts`, `Tracer/README.md`.
- **Hauler configs and docs:** fixtures, 13 example configs, `configuration-and-roles.md`, `source-overview.md`, `logging.md`, `deployment.md`, `README.md`, example READMEs.
- **Deployment:** 15 `workers/*.yml`, 15 generated `configuration/*/configuration.yml`, `validate-config.sh` (including its unknown-key allow-list), `tools/gen_deployment_diagram.py` and `.drawio` annotations.
- Deployed workers pin a Hauler release (`default-templates/wis2hauler-version.yml`); a config using new names fails on a release that does not know them.

## Options considered
1. **Hard rename in one release.** Simple code, but every deployed config and any script using the admin API breaks at upgrade.
2. **Accept both names for one release, then remove the old ones.** The old name logs a deprecation warning; setting both is a validation error. More code for a short time, no flag day.
3. **Keep the old names.** Zero risk, does not meet the goal.

## Decision
Option 2.
- Keys: `subscriber.mqtt.subscribe` and `subscriber.mqtt.exclude` (names confirmed final by the Maintainer, 2026-10-26). `overridelist` is unchanged.
- Admin API: `subscribe` and `exclude` keys, old names still accepted during the transition.
- Order: release Hauler 2026.10.2 first; then migrate Deployment (`workers/*.yml`, regenerated configs, `validate-config.sh`, diagram tool) and bump its pinned version; remove the old names only when the Maintainer says so.
- Admin API: a `/set` using an old name reports its change under the new key (plus a `warnings` entry); `GET ?key=whitelist|blacklist` still answers under the requested key and is left out of the full listing.
- Setting both spellings of one key is an error (config and API).
- Internal identifiers renamed to match (`isExcluded()`, `effectiveExclude`, ...).
- `Filter` outcome `blacklisted` renamed to `excluded`, with a changelog note and an update to Tracer and `docs/logging.md`.

## Maintainer decisions (2026-10-26)
1. Key names `subscribe` / `exclude` are final.
2. Rename the `Filter` outcome `blacklisted` to `excluded`; the Maintainer will update downstream tools (log queries, dashboards, Tracer consumers).
3. Old config keys and old admin API names stay accepted until the Maintainer says otherwise; no removal date.
4. Release: 2026.10.2.

## Consequences
Config and API vocabulary becomes self-explanatory. During the transition both names exist in code, tests and docs. Log queries on `outcome=blacklisted` break if the outcome is renamed.

## Verification
Implemented in Hauler. `tsc --noEmit` is clean. `bun` is not available in this environment, so `bun test` was NOT run; instead the suite was run under Node 22 with a small `bun:test` shim: 527 tests (515 before, 12 new), 514 pass. The 13 failures are the same tests that fail identically on the unmodified HEAD and come from Bun-only runtime APIs (`Bun.serve`, `main` tests) or three downloader test files that do not load under Node. Run `bun test` before releasing. Deployment is not migrated yet.
