# AGENTS.md — wis2hauler

Instructions for any coding agent or human contributor working in this repo. Tool-neutral on purpose.

Bun/TypeScript WIS2 downloader (SUBSCRIBER, DOWNLOADER, CLEANER, REPORTER, REPLAYER roles) backed by Redis/Valkey and aria2. See `README.md` and `docs/` for the product docs.

## Commands

- Typecheck: `bun run typecheck` (`tsc --noEmit`)
- Tests: `bun test`
- Run: `bun src/main.ts <config.yaml>` (sanitized example: `fixtures/example.valid.yaml`)
- Release version bump: `bun scripts/bump-version.ts` (main) or `bun scripts/bump-version.ts Tracer/VERSION`. Format `YYYY.M.X`, no leading zero on the month. Updates `package.json` too.

Before calling anything done: typecheck and tests both pass, and say so. Redis changes must also be tried against a real cluster (see ADR 0005).

## Where things live

- `docs/` — committed product docs. `docs/decisions/` — ADRs (why we chose X, what we rejected). Read the relevant ones before changing a mechanism they cover.
- `CHANGELOG.md` — user-visible changes per release. Update it with every change.
- `notes/`, `_to_delete/`, `dev.yaml`, `dist/` — local only, gitignored. Never commit them. Durable conclusions from `notes/` go into an ADR.
- `Tracer/` — standalone log-tracing CLI with its own `VERSION` and release cadence.

## Workflow

1. Substantial change (new mechanism, config key, behavior change): write a short ADR with status `proposed` first and wait for the Maintainer's decision. Small fixes skip this.
2. Implement. One logical change per commit. Version bumps are their own commit.
3. Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`), subject under ~70 chars, no duplicate commits.
4. Record in the ADR or changelog what was actually verified, including what was NOT run.
5. Never push to, or change, production from here. Production findings come from the Maintainer.

## Standing rules (each has an ADR)

- Any per-entry delay that can be large or long-tailed needs a hard cap, and must be checked against `runConsumerLoop`'s batch behavior (ADR 0002, 0003).
- `subscriber.weight-sources`: once set, unlisted keys, including `origin`, get weight 0 (ADR 0002).
- Raw stream trim: `XTRIM MINID` keyed off the consumer cursor is primary; `MAXLEN` is only a dead-consumer backstop (ADR 0004).
- Any multi-key Lua/MULTI in Redis Cluster mode needs a shared hash tag and a real-cluster test (ADR 0005).
- `data_id` is the key to trace a notification end to end; keep it on every log line and Redis record that handles one (ADR 0006).
- Debug-only work on hot paths must be gated by `SourceLogger.debugEnabled()`; `log.level: debug` must be the only switch (ADR 0006).
- Default `global.log.level` is `info`; use the per-role runtime override for short traces (ADR 0009).
- A DOWNLOADER and its aria2 are always a 1:1 pair. `max-connection-per-server` is per aria2 process with no fleet-wide cap (ADR 0007, 0008).
