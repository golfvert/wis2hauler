# 0008. Second DOWNLOADER; keep aria2 concurrency at 60; defer connection semaphore

- Status: accepted (second DOWNLOADER, concurrency); deferred (semaphore)
- Date: 2026-10-02 (analysis 2026-10-03)

## Context
Peak is about 35,000 files in 15 minutes, mostly under 2 KB, so the limit is per-file fixed cost, not bandwidth. Misses persisted at the busiest hour. Error stream empty, no restarts, raw stream healthy (ADR 0004). cadvisor: DOWNLOADER up to 30% CPU, aria2 up to 5%.

## Decision
- Add a second DOWNLOADER, container `thirteen`, same config as `eleven`, as an ordinary second consumer on the same queue. Went live during the real peak, knowing it reintroduces the two-aria2-on-one-source risk.
- Keep `max-concurrent-downloads` at 60: night of 2026-10-02 showed aria2 never saturated (`num_active` max 30, `num_waiting` 0).
- Keep the fleet-wide Redis-backed per-host connection semaphore deferred. Its trigger (`num_active` pinned at 60) did not fire.

## Consequences
`thirteen` took a real share (about 50/50 at peak; 77,036 vs 96,111 aria2 completions overall). No missed files that night.

Not proven: that `thirteen` was the fix. The night was about 24% lighter (raw-stream peak 103,723 vs 137,063). Gaps: no `XINFO CONSUMERS` snapshots, no post-burst `aria2.tellStopped`, and combined aria2 completions in the best 15 minutes (18,027) do not match the 35,000 figure. A night at or above 137k is the real test.
