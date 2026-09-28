# Examples

Runnable deployment examples for wis2hauler, ordered from the simplest
possible setup to a fully redundant, horizontally-scaled architecture.
Each one is a self-contained Docker Compose stack (wis2hauler + aria2 +
a Redis-compatible store, plus whatever else that example adds) with its
own `configuration.yml` and a README explaining what it demonstrates,
what's different from the previous step, and how to run it.

These exist to be read *and* run: clone the repo, `cd` into an example,
bring it up, and watch it actually subscribe and download against the
real WIS2 Global Brokers — rather than inferring a working deployment
shape purely from [`docs/configuration-and-roles.md`](../docs/configuration-and-roles.md)
and [`docs/deployment.md`](../docs/deployment.md). Each example's own
README cross-references those docs for the config fields it exercises,
rather than re-explaining them.

Numbering reflects the order they're meant to be read/tried in, not
necessarily deployment maturity — later examples build on concepts
(splitting roles across processes, Redis Cluster, replica redundancy)
introduced by earlier ones.

## Examples

1. **[`01-single-node`](01-single-node/)** — one wis2hauler process
   running `SUBSCRIBER,DOWNLOADER,CLEANER,REPORTER`, one standalone
   Redis/Valkey, one aria2. No `global.local-broker` configured, so
   nothing is republished — files are downloaded, sit in `./downloads`,
   and are cleaned up after `cleaner.keep-in-cache` elapses. The
   minimum viable deployment described in the main README.
2. **[`02-split-roles`](02-split-roles/)** — SUBSCRIBER/CLEANER/REPORTER
   and DOWNLOADER separated into two processes sharing one Redis, so
   MQTT ingest and download orchestration no longer compete for the
   same process. Also adds a second subscribed topic and a bigger
   aria2, with the two scaled together deliberately (see that
   example's own README).
3. **[`03-split-queues`](03-split-queues/)** — two independent
   queue pipelines (own SUBSCRIBER + DOWNLOADER each) rather than one
   SUBSCRIBER covering several topics. Its own phases add redundancy
   with broker diversity for both queues, then publish over real TLS
   (Traefik + Let's Encrypt DNS-01 via Infomaniak).
4. **Redis Cluster backing store** *(planned)* — the same kind of
   setup, backed by a Redis Cluster (minimum 6 nodes) instead of a
   single node.
5. **Full redundant architecture** *(planned)* — everything above
   combined: multiple queues, redundant SUBSCRIBER/DOWNLOADER replicas
   with broker diversity, a Redis Cluster backing store, and singleton
   roles (CLEANER/REPORTER/REPLAYER) participating in leader election
   across replicas.

This list is updated as each example is built.
