# 0010. Reject GB1/GB2 split as a CPU fix

- Status: rejected for CPU; later done for another reason
- Date: 2026-09-23

## Context
SUBSCRIBER CPU was high. Considered splitting GB1 and GB2 connections into separate containers.

## Decision
Rejected for CPU. GB1/GB2 are a redundancy pair carrying overlapping traffic; GB2 has a 2 s stagger and mostly produces cheap duplicate drops by `wnm.id`. The expensive work is in the single shared consumer loop, which does not know which connection a message came from.

## Consequences
On 2026-10-01 the busiest source was split into two replicas anyway (one per global broker, same `queue-two`), to spread broker connection load, not stream headroom. Whether it helped CPU or misses was not isolated in the notes.
