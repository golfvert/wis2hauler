# 0009. Default log level `info`, per-role runtime override

- Status: accepted
- Date: 2026-10-01

## Context
Debug logging is very large on a busy feed. While investigating misses, the deployed configs were found to be at `info`, so the debug-gated logs were empty, which explained "nothing found" when grepping missing `data_id`s.

## Decision
Keep `global.log.level: info` as the standing default. For a short trace, change the level at runtime for one role without a restart: `POST /set {"log-level-role": {"role": "SUBSCRIBER", "value": "debug"}}` on the admin port (8080); `value: null` clears it. Images without `curl` can use `wget`. Reset after the window.

## Consequences
`info` cannot be silenced and `warn` is more verbose than `info` (see `docs/logging.md`). Overrides are per process and lost at restart.
