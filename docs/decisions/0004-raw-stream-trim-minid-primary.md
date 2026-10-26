# 0004. Raw stream trim: MINID primary, MAXLEN backstop

- Status: accepted
- Date: 2026-09-22
- Related: commits 07303ad (2026.09.18), c9abbac (2026.09.19), 1e8df6e

## Context
A download on worker eight (queue-four) was confirmed lost: evicted from the raw ingest stream by count-based `MAXLEN` before the consumer's `XREAD` reached it. A count cap cannot know whether the consumer has read an entry.

## Decision
The consumer loop runs a periodic `XTRIM ... MINID ~ <read cursor minus margin>` as the primary trim, so it cannot remove unread entries. `RAW_STREAM_MAXLEN` stays only as a backstop for a dead consumer, raised to 500,000. Health check every 5 s writes `Redis` log events (`raw-stream-trimmed`, `raw-stream-near-cap` at 80%, `raw-stream-entries-trimmed-unread` when confirmed loss).

A CI regression (first health-check tick used cutoff `0-0`) came from `lastHealthCheckAt` seeded to `0`; fixed by seeding it with the current time (1e8df6e).

## Consequences
The stream shrinks when the consumer is caught up. Peak observed on 2026-10-02 was `xlen` 137,063 with `first_entry_age_seconds` bounded, so eviction is not the cause of misses seen then.

## Verification
Test results were not recorded in the notes for this change. The 2026-10-02 production figures come from overnight snapshots (see `docs/logging.md`).
