# 03 — Split queues

Two fully independent pipelines in one deployment, each on its own
`global.queue`, each with its own SUBSCRIBER and DOWNLOADER — rather
than [`02-split-roles`](../02-split-roles/)'s one SUBSCRIBER covering
several topics for one shared queue. This is the horizontal-scaling
lever `02-split-roles`'s own README pointed at: past a certain volume,
splitting topics across independent SUBSCRIBER/queue pairs rather than
piling more topics onto one SUBSCRIBER.

## What it runs

| Queue | Instance | Roles | Topic |
|---|---|---|---|
| `queue-1` | `sub-1` | `SUBSCRIBER,CLEANER,REPORTER` | `cache/a/wis2/jp-jma-gts-to-wis2/#` (JMA) |
| `queue-1` | `down-1` | `DOWNLOADER` | — |
| `queue-2` | `sub-2` | `SUBSCRIBER` | `cache/a/wis2/int-eumetsat/#` (EUMETSAT) |
| `queue-2` | `down-2` | `DOWNLOADER` | — |

The two topics are the same ones `02-split-roles` ran on a single
SUBSCRIBER — split here across two independent queues instead, to show
the alternative.

### Only one CLEANER, not one per queue

`global.queue` is required whenever `CLEANER` is active (see
[`global.queue`](../../docs/configuration-and-roles.md#globalqueue--required-when-subscriber-downloader-or-cleaner-is-active)),
which might suggest `sub-2` needs its own `cleaner:` section too. It
doesn't: CLEANER's actual file-deletion sweep (`src/cleaner/sweep.ts`,
`gc.ts`) never reads `queue` at all — it works across every downloaded
file in the shared Redis store regardless of which queue processed it.
`queue` is only required on CLEANER's config because one of its five
loops (`errors.ts`'s "Poll Errors", reading `wis2gc:error:<queue>:<worker>`)
happens to need a queue value to read from — and nothing in this
codebase currently writes to that stream, so today it's inert either
way. One CLEANER, anywhere in the deployment, is enough. (`REPORTER`
similarly isn't queue-scoped — one instance covers metrics for the
whole deployment.)

### Shared `./downloads`, not one per queue

Both `down-1` and `down-2` write into the same `./downloads` directory,
via the same `aria-download: /downloads`. Safe to share:
`downloader.rename-to: "topic"` derives each file's path from its WIS2
topic, which is centre-scoped (`jp-jma-gts-to-wis2/...` vs.
`int-eumetsat/...` here) — the two queues' files can't collide. Keep
them separate instead if you want harder isolation between queues (a
different `aria-download` per DOWNLOADER, and CLEANER still only needs
to exist once).

## Running it

```bash
docker network create wis2hauler   # if it doesn't already exist
mkdir -p downloads logs-sub-1 logs-down-1 logs-sub-2 logs-down-2
docker compose -f wis2hauler.yml up -d
```

```bash
curl http://localhost:8110/metrics   # sub-1 (REPORTER)
curl http://localhost:8120/get       # sub-2 admin API -- no REPORTER here
```

No `global.local-broker` configured yet (same as `01-single-node` and
`02-split-roles`'s base example) — nothing republished, files just land
in `./downloads`.

## Further phases

- **[`phase-2-redundancy`](phase-2-redundancy/)** — doubles SUBSCRIBER
  and DOWNLOADER for *both* queues, and makes the redundant replica of
  each pair connect through different Global Brokers entirely.
- **[`phase-3-tls`](phase-3-tls/)** — turns publishing back on and
  serves the downloads over real TLS through Traefik, via Let's
  Encrypt's DNS-01 challenge against Infomaniak's API.
