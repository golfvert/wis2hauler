# 02 — Split roles

Builds on [`01-single-node`](../01-single-node/): the same pipeline, but
`SUBSCRIBER`/`CLEANER`/`REPORTER` and `DOWNLOADER` now run as two
separate wis2hauler processes instead of one, sharing one Redis. Also
adds a second subscribed topic and a bigger aria2.

## What's different from example 1

### Roles split across two processes

- **`wis2hauler-sub`** — `SUBSCRIBER,CLEANER,REPORTER`. No `downloader:`
  section in its config; it never touches aria2 or `/downloads`.
- **`wis2hauler-downloader`** — `DOWNLOADER` only. No `subscriber:` or
  `cleaner:` section; it never opens an MQTT connection.

What actually wires them into one pipeline is `global.queue: queue`
being the **same value** in both `configuration-*.yml` files — both
instances join the same Redis Streams consumer group under that name,
so DOWNLOADER reads exactly what SUBSCRIBER queues. `global.worker`
must instead be **different** on each (`sub` / `downloader` here) —
it's the per-instance identity used in Redis key names and the
leader-election heartbeat; two instances sharing a worker name corrupt
each other's state. See
[`../../docs/configuration-and-roles.md`](../../docs/configuration-and-roles.md#globalworker--required)
and the `global.queue` entry just above it.

This is the same split that lets either side scale or fail
independently — a SUBSCRIBER doing heavy per-message decision work
no longer competes for the same event loop as DOWNLOADER driving
aria2, and either one can be given more (or fewer) resources on its
own. Both instances still get an `http-port` (always bound, regardless
of role — see the doc above), mapped to different host ports (`8080`
for `sub`, `8081` for `downloader`) since they run on the same host in
this example.

**Note:** for runnability, both processes are still composed together
on one host here, both pointed at the same single-node `valkey`. The
whole point of this split, though, is that they don't have to be —
`wis2hauler-sub` and `wis2hauler-downloader` can just as well run on
two different hosts, as long as both reach the same Redis (and
`wis2hauler-downloader` reaches its own aria2). That's the shape
the later, full-redundant example in this series works towards
(see [`../README.md`](../README.md) for the planned list).

### A second subscribed topic

`configuration-sub.yml`'s whitelist now also carries
`cache/a/wis2/int-eumetsat/#`, alongside example 1's JMA topic —
demonstrating that `subscriber.mqtt.whitelist` is a plain list, not a
single value, and that one SUBSCRIBER instance is meant to cover
several centres/topics at once rather than needing one instance per
topic.

### A "bigger" aria2

`CONCURRENT_DOWNLOADS` goes from example 1's `16` to `32`,
`CONNECTIONS_PER_SERVER` from `12` to `16`, `MAX_TRIES` comes down from
`5` to `2`, and `downloader.aria-inqueue` in `configuration-downloader.yml`
moves from `200` to `300` — each for a different reason, not just
"bigger everywhere":

- `aria-inqueue` is wis2hauler's own backpressure knob (see
  [`downloader.aria-inqueue`](../../docs/configuration-and-roles.md#downloaderaria-inqueue--required)
  in the docs) — the max number of downloads this instance will have
  queued or in-flight with aria2 at once. It has to stay in a sane
  range relative to `CONCURRENT_DOWNLOADS`, or one becomes the
  bottleneck hiding the other: too low relative to aria2's own
  capacity leaves aria2 under-fed and bandwidth idle; too high relative
  to it just queues more inside aria2's own backlog without actually
  downloading any faster. `300` against `CONCURRENT_DOWNLOADS`'s new
  `32` keeps the downloader's own queue comfortably ahead of aria2's,
  rather than becoming the limiter itself.
- `CONNECTIONS_PER_SERVER` is intentionally only bumped a little,
  nowhere near doubled like `CONCURRENT_DOWNLOADS`. This caps
  connections *per origin server*, not overall — pushing it too high
  against a single real-world origin tends to produce outright errors
  (HTTP 502s, rate-limiting) rather than more throughput, especially
  once several centres' downloads are landing on the same handful of
  origin hosts. `CONCURRENT_DOWNLOADS` is the knob that actually buys
  you more parallelism across *different* servers/files.
- `MAX_TRIES` coming down to `2` is a deliberate trade: fewer retries
  per file means a flaky origin fails faster and frees the slot back up
  for other work, at the cost of giving up sooner on a file that would
  have succeeded on a 3rd or 4th attempt. Worth tuning against how
  reliable your actual sources are, not copied blindly.

## Running it

Same external network as example 1 (create it once if you haven't
already, or if you're running both examples side by side, they can
share it):

```bash
docker network create wis2hauler   # if it doesn't already exist
```

From this directory:

```bash
mkdir -p downloads logs-sub logs-downloader
docker compose -f wis2hauler.yml up -d
```

Check both instances independently:

```bash
curl http://localhost:8080/metrics   # wis2hauler-sub (REPORTER)
curl http://localhost:8081/get       # wis2hauler-downloader admin API -- no REPORTER here, so no /metrics
cd ./logs-sub
ls -ail
cd ../logs-downloader
ls -ail
cd ../downloads
ls -lR
```

Same as example 1: no `global.local-broker` configured, so nothing is
republished — downloaded files land in `./downloads` and are cleaned
up by `wis2hauler-sub`'s CLEANER role after `cleaner.keep-in-cache`
(still 600s).

## Further phases

This base setup is phase 1 of three. Each phase builds on the previous
one and lives in its own subdirectory with its own compose file and
README:

- **[`phase-2-publish`](phase-2-publish/)** — turns on `global.local-broker`
  so SUBSCRIBER/DOWNLOADER actually republish, and adds Caddy to serve
  the downloaded files as clickable links (`downloader.download-url`).
- **[`phase-3-traefik`](phase-3-traefik/)** — fronts phase 2 with
  Traefik, as a genuinely separate compose stack that adds/removes
  independently of phase 2 — no changes to phase 2's own files.
