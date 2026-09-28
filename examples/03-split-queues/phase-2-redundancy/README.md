# 03, phase 2 — redundancy, for both queues

Builds on the base [`03-split-queues`](../) example: same two queues,
same two topics, now with a redundant SUBSCRIBER and a redundant
DOWNLOADER on *each* queue — 8 wis2hauler instances, 4 aria2, one
Redis.

## The redundant replica uses different brokers, on purpose

Per queue, the `a` replica keeps the original broker pair
(`globalbroker.meteo.fr` / `globalbroker.inmet.gov.br`); the `b`
replica connects to a **different** pair instead —
`wis2broker.globaldata.nws.noaa.gov` (NOAA) and `gb.wis.cma.cn` (CMA).
Both pairs carry the same global WIS2 traffic — every Global Broker
republishes the same notifications, regardless of which centre hosts
it — so this isn't about reaching different data, it's about not
having both replicas share a single point of failure. Two identical
replicas both pointed at `meteo.fr`/`inmet.gov.br` survive a
DOWNLOADER crash or a host reboot, but not a problem with those two
brokers themselves (an outage, a network path issue between you and
France/Brazil specifically); connecting the backup through entirely
different infrastructure covers that case too. Swap in whichever real
Global Brokers make sense for your own network position — the point is
that the pair differs, not the specific choice made here.

## Why redundant SUBSCRIBERs don't double-download

`sub-1-a` and `sub-1-b` both subscribe to the same JMA topic and will
both see (a copy of) every matching notification — deliberately, that's
the whole point of the broker diversity above. They don't end up
downloading everything twice: `checkAndClaimDownload` (see
`src/subscriber/store.ts` / `consumer.ts`) does an atomic
Redis `SET ... NX` claim per `downloaderId` before queuing a download,
so whichever replica's message happens to get processed first wins the
claim and the other backs off, having found the work already spoken
for. No coordination between `sub-1-a` and `sub-1-b` is configured or
needed — this is exactly the mechanism, already live in every example
in this series, that makes it safe.

## Why redundant DOWNLOADERs don't need any extra config

`down-1-a` and `down-1-b` share `queue: queue-1`, so — same as
`02-split-roles`'s `global.queue` explanation — they join the *same*
Redis Streams consumer group and split whatever `sub-1-a`/`sub-1-b`
queue between them automatically. Each still needs its own aria2
(`aria2-1-a` / `aria2-1-b`) — see the main README's "one aria2 instance
per DOWNLOADER" note — since wis2hauler drives aria2 over one
persistent JSON-RPC connection each, not a pool.

## CLEANER/REPORTER redundancy, via leader election

Unlike `SUBSCRIBER`/`DOWNLOADER` (scale-out, both replicas always
active), `CLEANER` and `REPORTER` are singleton-style roles — see the
main README's Roles table. `sub-1-a` and `sub-1-b` both carry
`CLEANER,REPORTER` here specifically so that role gets its own
redundancy too: both replicas run a leader-election heartbeat, only the
elected primary actually sweeps files or serves `/reporter/primary`,
and the other takes over if it goes away. `sub-2-a`/`sub-2-b` don't
need their own — one CLEANER for the whole deployment is enough (see
the base example's README for why), and adding a third/fourth would
just be more election overhead for no benefit.

## Ports

| Instance | Host port |
|---|---|
| `sub-1-a` / `sub-1-b` | `8110` / `8111` |
| `down-1-a` / `down-1-b` | `8112` / `8113` |
| `sub-2-a` / `sub-2-b` | `8120` / `8121` |
| `down-2-a` / `down-2-b` | `8122` / `8123` |

## Running it

```bash
docker network create wis2hauler   # if it doesn't already exist
mkdir -p downloads logs-sub-1-a logs-sub-1-b logs-down-1-a logs-down-1-b \
         logs-sub-2-a logs-sub-2-b logs-down-2-a logs-down-2-b
docker compose -f wis2hauler.yml up -d
```

```bash
curl http://localhost:8110/metrics   # whichever of sub-1-a/sub-1-b is currently elected primary answers with real data; the other still responds, just not as primary
```
