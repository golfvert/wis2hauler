# 0013. Rename `overridelist` to `override`

- Status: accepted
- Date: 2026-10-26
- Related: ADR 0012; `src/config/schema.ts`, `src/config/validate.ts`, `src/config/runtime.ts`, `src/admin/runtime-store.ts`

## Context
After ADR 0012 the subscriber lists are `subscribe` and `exclude`; `overridelist` kept its old suffix. The Maintainer asked for `override` for consistency.

## Options considered
1. **Hard rename.** Breaks every deployed config and admin API script at upgrade.
2. **Accept both names, old one deprecated** (the mechanism ADR 0012 added). No flag day.

## Decision
Option 2. `subscriber.mqtt.override` is the key; `overridelist` is migrated to it at load with a deprecation warning, and mapped in `POST /set` (change reported under `override`, plus a `warnings` entry). Setting both is an error. Internal identifiers follow (`getOverride()`, `validateOverrideRules()`, `deps.override`). `GET /get?key=overridelist` was never readable and stays unsupported. Removal of the old name is left to the Maintainer, as in ADR 0012. Release: 2026.10.3.

## Consequences
Consistent vocabulary. Deployment configs that use `overridelist` keep working but log a warning until migrated. `nodered/flows.json` (the legacy Node-RED flow) is not changed.

## Verification
`tsc --noEmit` clean; `bun test src`: 598 pass, 0 fail (3 new tests for the old name). Not checked: a real deployment using an `overridelist` config.
