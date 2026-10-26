# 0005. No multi-key Lua without a shared hash tag

- Status: rejected (as implemented); condition recorded for any retry
- Date: 2026-09-23
- Related: commits 3ad32e0 (introduced), d2d81b7 (fixed); `src/subscriber/lua.ts`

## Context
To cut SUBSCRIBER CPU, `LUA_CHECK_AND_CLAIM` combined the completion check and the claim in one `EVAL` with two keys (`...:complete:downloader_id:<id>` and `...:set:downloader_id:<id>`). Those keys have no shared hash tag, so in Redis Cluster mode they land on different slots and Redis rejects the script (`CROSSSLOT`). Every message needing a claim check threw and was dropped, which stalled downloads fleet-wide. It had only been tested against the in-memory `FakeStore` and `tsc`.

## Decision
Revert `checkAndClaimDownload` to two sequential calls (`EXISTS` then `SET NX EX`) behind the same interface. Keep `lua.ts` in the repo, unused, with a warning comment. Pipelined `HSET`+`EXPIRE` on a single key (`writeDownloadJob`, `recordLineagePubtime`, `recordGlobalCacheLineagePubtime`) is safe and stays.

## Consequences
Any future multi-key Lua/MULTI needs (a) a shared hash tag such as `{<id>}` in both keys, (b) a compatibility plan for old keys (claim TTL 900 s, complete TTL 21400 s), (c) a test against a real cluster before production.
