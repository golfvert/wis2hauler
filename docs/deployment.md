# Deployment options

This document covers how to actually run wis2hauler: as a container or as a standalone binary, against a single Redis node or a Redis Cluster, and how the pieces (this app, aria2, Redis, an MQTT broker if you're publishing locally) fit together.

It replaces the old Node-RED-era `docker-compose_reference.md`, adapted to this app's actual interface — the two systems differ in several important ways covered below.

---

## What you need to run one replica

A "replica" is one running instance of the `wis2hauler` binary, configured with one YAML file. To be useful, a replica carrying `DOWNLOADER` needs three things alongside it:

1. **Redis** (or Redis Cluster) — the shared coordination/state store every role reads and writes: work queues (Redis Streams), dedup keys, the leader-election hash, cached-file retention timers, Prometheus counters. Every replica in a deployment must point at the *same* Redis/Redis Cluster.
2. **aria2**, running with its JSON-RPC interface enabled (`--enable-rpc --rpc-secret=<secret> --rpc-listen-all`), reachable over WebSocket. wis2hauler drives aria2 entirely through this one JSON-RPC connection — it never shells out to it.
3. A way to serve the downloaded files back out to WIS2 (`downloader.download-url`) — typically a plain static file server (nginx, Caddy) pointed at the same directory aria2 downloads into, or an S3-compatible bucket if `downloader.rename-to: s3` is used instead.

`SUBSCRIBER`-only or `CLEANER`/`REPORTER`/`REPLAYER`-only replicas don't need aria2 at all — see [`configuration-and-roles.md`](configuration-and-roles.md) for which config sections each role actually requires.

---

## Docker

### Obtaining pre-defined images

Check existing images in https://github.com/golfvert/wis2hauler/pkgs/container/wis2hauler — these already include geoip-lite's data files (see the note below), so there's nothing extra to do for REPORTER's `/caddy` country lookups to work.

### Building the image

**This repository's `Dockerfile` never runs `bun install` or `bun build` itself.** It only copies in an already-compiled binary. Build that binary first:

```bash
bun build --compile --target=bun-linux-x64-musl src/main.ts --outfile wis2hauler
# arm64 hosts: --target=bun-linux-arm64-musl instead
```

The `--target=...-musl` variant is required — the Dockerfile's base image is `alpine:3.24` (musl libc), and a binary built with the default `bun-linux-x64`/`bun-linux-arm64` target is glibc-linked and fails immediately on Alpine with a dynamic-linker error. This is a different artifact than a glibc build you might also produce for a bare-metal Linux deployment; build once per target you actually deploy to.

You also need geoip-lite's data files staged at `dist/geoip-data` (arch-independent — same for every target), since `bun build --compile` does **not** bundle them (found live, 2026-09-13 — see `src/reporter/run.ts`'s header comment for why):

```bash
mkdir -p dist/geoip-data
cp -r node_modules/geoip-lite/data/* dist/geoip-data/
```

Then:

```bash
docker build -t wis2hauler:latest --build-arg TARGETARCH=amd64 .
```

`ca-certificates` (for `mqtts://`/`wss://`/TLS-Redis) is the only apk package the image installs; every dependency (ioredis, mqtt.js, js-yaml, winston, ajv, geoip-lite, prom-client) is pure JavaScript. geoip-lite's data files are the one exception to "bundled into the compiled binary" — they're copied in as a separate `geoip-data` directory next to the binary instead (only needed if you run the `REPORTER` role; every other role never touches geoip-lite at all).

### Running it

The image expects three mount points:

| Container path | What it is |
|---|---|
| `/configuration.yml` | The config file, mounted directly (not a directory) — required, no default baked in. |
| `/downloads` | Must be the **same** directory aria2 itself writes into (`aria2.conf`'s `dir=`), and must match `downloader.aria-download` in the config file exactly — same host, same case. This app's embedded-content fast path also writes here directly, bypassing aria2 entirely. |
| `/logs` | Only used when `global.log-to` is `file` rather than the `stdout` default. |

```yaml
services:
  wis2hauler:
    image: ghcr.io/golfvert/wis2hauler:2026.09.1
    user: "1000:1000"          # or bake a different default at build time with --build-arg UID=/--build-arg GID=
    volumes:
      - ./configuration.yml:/configuration.yml:ro
      - ./downloads:/downloads
      - ./logs:/logs
    ports:
      - "8080:8080"             # global.http-port — admin API + whichever of /reporter/primary, /replayer/primary, /caddy apply
    restart: unless-stopped
    networks:
      - wis2hauler

  aria2:
    image: golfvert/aria2:1.0.7
    environment:
      - TZ=Europe/Paris
      - RPC_SECRET=secret
      - CONCURRENT_DOWNLOADS=32
      - CONNECTIONS_PER_SERVER=12
      - MAX_TRIES=5
      - QUIET=false
    volumes:
      - ./downloads:/downloads
    networks:
      - wis2hauler

  valkey:
    image: valkey/valkey:9.0.6-alpine3.24
    networks:
      - wis2hauler

networks:
  wis2hauler:
    external: true
```

Debug can be toggled at runtime through the admin API: `POST /set {"debug": ["SUBSCRIBER"]}` against whichever port `global.http-port` binds to.

With the docker-compose.yml above, use:

```  
  aria-secret: secret
  aria-url: ws://aria2:6800/jsonrpc
```

in the configuration file, in the `global.downloader` section.

### Non-root user

The image creates a `wis2` user (default UID/GID `1000:1000`) and never runs as root. There are two independent ways to change the UID/GID it runs as:

- **At image build time**, with `--build-arg UID=... --build-arg GID=...`, if you want a different baked-in default across every deployment of that image (requires a rebuild).
- **At container run time**, with Compose's own `user:` field (as in the example above) — no rebuild needed, and this works even for a UID/GID with no matching `/etc/passwd` entry, since the binary only ever reads/writes files by numeric uid/gid and never resolves a username.

If your bind-mounted `downloads`/`logs` directories need their ownership fixed up automatically rather than matched by hand on the host, that's a `chown`-then-drop-privileges entrypoint script (the common `PUID`/`PGID` pattern) — deliberately not built into this image, to keep it a single static `USER` line with no root-started entrypoint.

### Reverse proxy / Traefik

wis2hauler never registers itself with anything — it only binds `global.http-port` and does nothing else about exposing it. If you're running Traefik in front of it, that's ordinary Docker-label-based routing configured at the Compose/infrastructure layer, entirely outside the app:

```yaml
services:
  wis2hauler:
    # ...
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.wis2hauler.rule=Host(`wis2.example.org`) && PathPrefix(`/wis2hauler`)"
      - "traefik.http.middlewares.wis2hauler-strip.stripprefix.prefixes=/wis2hauler"
      - "traefik.http.routers.wis2hauler.middlewares=wis2hauler-strip"
      - "traefik.http.services.wis2hauler.loadbalancer.server.port=8080"
```

---

## Running without Docker

Nothing about wis2hauler requires a container. A compiled binary (either from the github repository ot built with the plain, non-musl target on the host's own libc) or `bun src/main.ts` directly both work fine on any machine with network access to Redis and aria2:

```bash
bun build --compile src/main.ts --outfile wis2hauler
./wis2hauler /path/to/configuration.yml
# or, without a compile step:
bun src/main.ts /path/to/configuration.yml
```

**If you run the `REPORTER` role**, also fetch `geoip-data.tar.gz` from the same GitHub release as the binary and extract it into a `geoip-data` folder right next to the binary (`./wis2hauler` and `./geoip-data/` as siblings) — REPORTER's `/caddy` country lookup (`geoip-lite`) resolves its data directory relative to wherever the running binary actually lives, so this is the only placement that works without also setting `GEODATADIR` yourself:

```bash
mkdir -p ./geoip-data
tar -xzf geoip-data.tar.gz -C ./geoip-data
```

No other role touches geoip-lite, so skip this entirely for `SUBSCRIBER`/`DOWNLOADER`/`CLEANER`/`REPLAYER`-only replicas.

Run it under whatever process supervisor you already use (systemd, runit, pm2, ...) — there's nothing wis2hauler-specific about that part. This is the deployment shape the config's own comments assume by default: one or two replicas per host, config files and logs living directly on disk, no container runtime in the loop at all.

A systemd unit is typically the simplest option:

```ini
[Unit]
Description=wis2hauler (worker3)
After=network-online.target

[Service]
ExecStart=/opt/wis2hauler/wis2hauler /etc/wis2hauler/configuration.yml
Restart=on-failure
User=wis2hauler

[Install]
WantedBy=multi-user.target
```

---

## Single-node Redis vs. Redis Cluster

Every role that talks to Redis (which is every role — Redis is the shared bus and state store) goes through `global.redis`, which supports exactly two shapes:

```yaml
global:
  redis:
    mode: "single"
    nodes:
      - "redis:6379"          # exactly one "host:port" — more than one is a validation error in single mode
    # password: "..."          # optional
```

```yaml
global:
  redis:
    mode: "cluster"
    nodes:                     # one or more seed/startup nodes — ioredis discovers the rest of the cluster topology from these
      - "redis-1:6379"
      - "redis-2:6379"
      - "redis-3:6379"
    # password: "..."
```

Both modes expose the same command surface to the rest of the app (an `ioredis` `Redis` client or `Cluster` client, used interchangeably behind each role's store interface), so nothing else in the config or the app's behavior changes based on which mode you pick. The only code that branches explicitly on mode is the Cleaner's periodic Redis-side garbage collection sweep, which needs a Cluster-only `nodes('master')` call in cluster mode and a plain single-connection scan in single mode.

**When to use which:**

- **Single-node** is simplest and is fine for a low-volume national-centre deployment, a dev/staging setup, or a single-replica global-cache deployment where Redis itself doesn't need to survive a node failure independently of the app.
- **Cluster** is worth the operational overhead when you're running multiple DOWNLOADER/SUBSCRIBER replicas at real global-cache volume and want Redis itself to scale and tolerate a node loss without a manual failover. Every replica across your whole deployment (SUBSCRIBER, DOWNLOADER, CLEANER, REPORTER, REPLAYER alike) must be pointed at the same cluster — there's no partitioning of roles across separate Redis clusters.

A Redis Cluster needs at least 3 master nodes (plus replicas, if you want automatic failover) to be able to elect a new primary for a lost shard; a single Redis instance has no such requirement but is a single point of failure for the whole deployment's coordination state.

---

## Local MQTT broker(s) and publish-only outcomes

`global.local-broker` (up to two entries, wired to `PUB1`/`PUB2`) is where `SUBSCRIBER` republishes messages it decided not to download (a Global-Cache `no-cache` flag, an overridelist match) and where `DOWNLOADER` republishes completion notifications once a file has been downloaded and verified. Both roles, when active on the same replica, share the same PUB1/PUB2 connections rather than opening their own — the process's orchestrator (`main.ts`) owns opening and closing them once, for the whole process.

If you don't need a local broker at all (a pure-downloader setup where something else reads completions directly out of Redis), omit `global.local-broker` — this only produces a warning, not an error, at startup.

---

## Ports summary

| Port | Set by | Purpose |
|---|---|---|
| `global.http-port` (default `8080`) | this app | Admin API (`GET /get`, `POST /set`) plus whichever of `/reporter/primary`, `/replayer/primary`, `POST /replayer`, `POST /caddy` apply to the active roles. One shared HTTP server per replica, always running, regardless of active roles. |
| aria2's own RPC port (commonly `6800`) | your aria2 config, via `downloader.aria-url` | JSON-RPC/WebSocket control channel — wis2hauler is the only client expected to talk to it. |
| Redis's own port(s) | your Redis/Cluster config, via `global.redis.nodes` | Shared coordination/state store. |
| Your local MQTT broker's port(s) | your broker, via `global.local-broker[*].broker` | Where `SUBSCRIBER`/`DOWNLOADER` publish outcomes for local consumers. |

wis2hauler never announces any of its own ports to anything (no service discovery, no dynamic Traefik registration) — every port above is a value you choose and wire into whatever reverse proxy, firewall rule, or service mesh you're using, exactly like you would for any other plain binary.
