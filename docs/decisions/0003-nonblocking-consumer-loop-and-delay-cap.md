# 0003. Non-blocking consumer loop and hard cap on delay

- Status: accepted
- Date: 2026-09-20
- Related: commit 1e2b3b5 (maxInFlight, weight-delay-max-seconds first appear); 07303ad; ADR 0002

## Context
The first weight-sources rollout (`weight-delay-seconds: 10`, `de-dwd-global-cache: 0.2`, mean delay 50 s, unbounded tail) was deployed on a de-dwd-only SUBSCRIBER at 08:01 UTC. Downloads for all sources on that centre dropped to near zero within minutes while notifications kept arriving. Cause: `runConsumerLoop` read up to 500 raw-stream entries, then awaited the whole batch, including every entry's delay, before the next read. The expected maximum of N exponential draws is about `mu * H_N`; for N=500 and mu=50 s that is about 340 s, so the loop stopped reading for minutes at a time.

## Decision
1. `runConsumerLoop` no longer awaits a batch's dispatch before reading the next one. A `maxInFlight` backpressure limit (default 5000) pauses reading, never cancelling dispatched entries.
2. Add `weight-delay-max-seconds` (default 120) so the wait itself is bounded, which the operational requirement ("a download completes, including retries, in under 10 minutes") needs.

## Consequences
Rule for any future delay mechanism: evaluate it against the consumer loop's batch behavior and give it an explicit hard cap chosen from the percentile math. "Fine on average" is not enough for an exponential tail.

## Verification
Regression tests: a slow entry in an earlier batch must not delay a fast entry in a later one; `maxInFlight` holds reads until entries drain. Not re-run here.
