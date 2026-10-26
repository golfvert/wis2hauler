# 0002. Weighted source selection replaces `priority-global-cache`

- Status: accepted
- Date: 2026-09-20
- Related: commits b4b67a1 (2026.09.14), 1e2b3b5 (2026.09.15); `docs/configuration-and-roles.md`

## Context
With `subscriber.priority-global-cache` (ordered allowlist with a position-indexed stagger), `origin` raced unstaggered and the first-listed Global Cache almost as fast, so a few very active origin servers took most of the claim attempts. Production metrics for `de-dwd-gts-to-wis2` and `ca-eccc-msc` showed origin absorbing most downloads. aria2 enforces per-source connection limits, and several independent aria2 instances hitting one source made it return HTTP 502. A Global Cache relay can also advertise the byte-identical href as origin for some centres.

## Decision
Replace it with `subscriber.weight-sources` (source key to non-negative weight; keys are `origin` or the full raw `global-cache` string such as `de-dwd-global-cache`), `weight-delay-seconds` (scale, default 8) and, from 1e2b3b5, `weight-delay-max-seconds` (cap, default 120).

Delay = `min(-ln(U) * weightDelaySeconds / weight, cap)`. With independent exponential draws, source i wins the claim race with probability `weight_i / sum(weights)`, without coordination between candidates. The cap is a plain `min()`, so proportionality only holds for draws below it.

If `weight-sources` is unset, every source has weight 1. If set, any unlisted key, **including `origin`**, has weight 0 and is ignored. That is intentional but easy to misconfigure; it is correct when `mqtt.whitelist` already excludes origin topics.

Choosing values: for a target "p-th percentile of the lowest-weight source's wait is at most T", `mu = T / -ln(1-p)` and `weightDelaySeconds = mu * weight_min`. Deployed test config: `weight-delay-seconds: 5.2`, cap 120, `de-dwd-global-cache: 0.2`, other caches 1 to 1.5.

## Consequences
Load shifts away from origin toward mirrors by configuration. Any long-tailed delay must be evaluated against the consumer loop (ADR 0003). Fleet-wide per-host connection limits are still not solved (ADR 0008).

## Verification
Recorded at the time: `tsc --noEmit` and `bun test` (512 pass). Not independently re-run for this reconstruction.
