# 0007. Reject a single-source dedicated DOWNLOADER

- Status: rejected
- Date: 2026-10-02

## Context
`max-connection-per-server` (aria2's own maximum is 16) is enforced per aria2 process with no cross-instance coordination. Adding a replica that pulls from the same busy source can open up to 32 connections to it, as in the 502s that preceded ADR 0002. Idea considered: a dedicated SUBSCRIBER+DOWNLOADER+aria2 trio with weight 1 on only the saturated source and 0 elsewhere, to isolate its connections to one aria2.

## Decision
Rejected. Weight 0 means a source is never a candidate, so that subscriber has no fallback: any failure on the one source means the file is missed with no alternative source and the same href is retried until `max-tries`.

## Consequences
Not to be revisited in this form. The only remaining way to add capacity against one saturated source without removing multi-source redundancy is a fleet-wide connection limit per target host (ADR 0008, deferred).

Unverified: when one source wins the claim and then fails, whether a losing candidate on another source later gets a real attempt. Worth checking in code; it does not change this decision.
