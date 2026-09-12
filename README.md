# wis2hauler

This is a single-binary [WIS2](https://community.wmo.int/en/activity-areas/wis) downloader. It subscribes to WIS2 Global Brokers, downloads the data files referenced by incoming notification messages, verifies and (optionally) relocates them, republishes completion notifications, cleans up expired files, exposes Prometheus metrics, and can use WIS2 replayer for access to missed notifications on demand — all from one process, one Redis (or Redis Cluster) backing store, and one YAML configuration file.

Built with [Bun](https://bun.sh) and TypeScript. Ships as a single compiled executable. 

It requires two off-the-shelf tools to work:
- redis/alkey either as a standalone version or as a cluster used as a K/V store 
- aria2c a very efficient and scalable downloader

In its simplest form one wis2hauler, one redis/valkey node, one aria2 is sufficient to download (many) files from WIS2.
It can also be deployed in a redundant, scalable manner with multiple wis2hauler on multiple hosts, a redis cluster - minimum 6  nodes for redundancy -, one aria2 instance per DOWNLOADER.

It is also a reference implementation of a Global Cache and can be used operationally if needed.

Last, it can be deployed on bare metal linux hosts (same for redis/valkey and aria2) or on docker (search for golfvert/wis2hauler on hub.docker.com).

## Roles

A single running instance ("replica" or "worker") performs whichever of these five roles are listed in its config file's `global.roles`. Most single-node deployments run all five; a distributed deployment can split them across several replicas that all share the same Redis backing store.

| Role | What it does |
|---|---|
| `SUBSCRIBER` | Connects to up to two WIS2 Global Brokers (GB1/GB2), applies whitelist/blacklist/override rules, deduplicates, and queues matching notifications for download. |
| `DOWNLOADER` | Pulls queued work, downloads the referenced file via [aria2](https://aria2.github.io/), verifies its integrity, optionally relocates it (by date, by topic, or to S3), and republishes a completion notification, if local broker are defined. |
| `CLEANER` | Deletes locally cached files once their retention period (`cleaner.keep-in-cache`) has elapsed. |
| `REPORTER` | Exposes Prometheus metrics (downloads, errors, active IPs, latency) over HTTP. |
| `REPLAYER` | On request, fetches historical WIS2 notifications from a remote WIS2-GREP replay service and re-injects them into the pipeline. |

`CLEANER`, `REPORTER`, and `REPLAYER` are singleton-style roles: every replica carrying one of them participates in a lightweight Redis-backed leader election, but only the elected primary actually acts (schedules deletions, serves `/reporter/primary` metrics, answers replay requests). `SUBSCRIBER` and `DOWNLOADER` are scale-out roles instead — every replica carrying them works concurrently, coordinated through Redis Streams consumer groups rather than an election. Every replica, regardless of which roles it carries, also runs an always-on heartbeat that announces it to the others (this is what the election reads).

See [`docs/configuration-and-roles.md`](docs/configuration-and-roles.md) for the full picture, including the leader-election mechanics and timing.

## Quick start

```bash
bun install
cp fixtures/example.valid.yaml my-config.yaml   # edit to taste
bun src/main.ts my-config.yaml
```

A config file is a required positional argument — there is no default path. See [`docs/configuration-and-roles.md`](docs/configuration-and-roles.md) for every option, and `fixtures/*.yaml` for worked examples (a full multi-role config, a minimal single-role one, and one that fails validation on purpose).

Every running instance exposes a small HTTP admin API (`GET /get`, `POST /set`, plus role-specific routes) on `global.http-port` (default `8080`), regardless of which roles it carries — the same API a Node-RED admin UI used to expose. See the "Runtime admin API" section of the configuration doc.

## Building a standalone binary

```bash
bun build --compile src/main.ts --outfile wis2hauler
./wis2hauler my-config.yaml
```

For a musl-based container image (this repo's `Dockerfile` targets Alpine), cross-compile with an explicit musl target instead:

```bash
bun build --compile --target=bun-linux-x64-musl src/main.ts --outfile wis2hauler    # or bun-linux-arm64-musl
```

See [`docs/deployment.md`](docs/deployment.md) for Docker Compose examples, non-Docker deployment, and single-node vs. clustered Redis.

## Testing

```bash
bun test        # full test suite
bun typecheck    # tsc --noEmit
```

The test suite (55+ test files under `src/**/__tests__/`) exercises the pure decision logic of every role against fakes/in-memory stores — no live Redis, MQTT broker, or aria2 instance required.

## Documentation

- [`docs/deployment.md`](docs/deployment.md) — Docker vs. standalone binary, single-node vs. Redis Cluster, volumes, networking, reverse proxy/Traefik notes.
- [`docs/configuration-and-roles.md`](docs/configuration-and-roles.md) — every `configuration.yml` key, the five roles and how they combine, the leader-election/heartbeat mechanism, and the runtime HTTP admin API (`/get`, `/set`, `/replayer`).
- [`docs/source-overview.md`](docs/source-overview.md) — a guided tour of every file under `src/`, organized by module, for anyone modifying the code.

## Project layout

```
src/
  main.ts          # process entrypoint / orchestrator — owns every MQTT connection and the HTTP server
  debug.ts         # runtime debug-category toggling (static CLI baseline + dynamic admin-API set)
  admin/           # GET /get, POST /set — the runtime admin API
  config/          # YAML loading, schema, validation, the small live-patchable subset
  election/        # shared leader-election + always-on heartbeat primitive
  http/            # the one shared HTTP server every role's routes register onto
  logging/         # structured logging: sinks (stdout/file), per-role level gating
  mqtt/            # MQTT client wrapper
  redis/           # ioredis-backed store implementations (single-node or Cluster)
  wis2/            # WIS2 notification message type, topic grammar/matching, shared Redis key builders
  subscriber/ downloader/ cleaner/ reporter/ replayer/   # one directory per role
fixtures/          # example configuration files (valid, cleaner-only, intentionally invalid)
```

## License

Apache License 2.0 — see [`LICENSE`](LICENSE). Contributions are welcome via pull request.
