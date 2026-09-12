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

### Building the image

**This repository's `Dockerfile` never runs `bun install` or `bun build` itself.** It only copies in an already-compiled binary. Build that binary first:

```bash
bun build --compile --target=bun-linux-x64-musl src/main.ts --outfile wis2hauler
# arm64 hosts: --target=bun-linux-arm64-musl instead
```

The `--target=...-musl` variant is required — the Dockerfile's base image is `alpine:3.24` (musl libc), and a binary built with the default `bun-linux-x64`/`bun-linux-arm64` target is glibc-linked and fails immediately on Alpine with a dynamic-linker error. This is a different artifact than a glibc build you might also produce for a bare-metal Linux deployment; build once per target you actually deploy to.

Then:

```bash
docker build -t wis2hauler:latest .
```

The image needs no other build-time input — `ca-certificates` (for `mqtts://`/`wss://`/TLS-Redis) is the only package it installs; every dependency (ioredis, mqtt.js, js-yaml, winston, ajv, geoip-lite, prom-client) is pure JavaScript and already bundled into the compiled binary, including geoip-lite's data files.

### Running it

The image expects three mount points:

| Container path | What it is |
|---|---|
| `/configuration.yml` | The config file, mounted directly (not a directory) — required, no default baked in. |
| `/downloads` | Must be the **same** directory aria2 itself writes into (`aria2.conf`'s `dir=`), and must match `downloader.aria-download` in the config file exactly — same host, same case. This app's embedded-content fast path also writes here directly, bypassing aria2 entirely. |
| `/logs` | Only used when a role's `global.log.to` is `file` rather than the `stdout` default. |

```yaml
services:
  wis2hauler:
    image: wis2hauler:latest
    user: "1000:1000"          # or bake a different default at build time with --build-arg UID=/--build-arg GID=
    volumes:
      - ./configuration.yml:/configuration.yml:ro
      - ./downloads:/downloads
      - ./logs:/logs
    ports:
      - "8080:8080"             # global.http-port — admin API + whichever of /reporter/primary, /replayer/primary, /caddy apply
    restart: unless-stopped
    networks:
      - wis2

  aria2:
    image: p3terx/aria2-pro     # any aria2 image with RPC enabled works
    volumes:
      - ./downloads:/downloads
    networks:
      - wis2

  redis:
    image: redis:7
    networks:
      - wis2

networks:
  wis2:
    external: true
```

There is no CLI flag for debug categories — toggle them at runtime through the admin API instead: `POST /set {"debug": ["SUBSCRIBER"]}` against whichever port `global.http-port` binds to.

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

This is the same label-based pattern the old Node-RED deployment used at the infrastructure level. It is *not* the same thing as an app-level self-registration mechanism (announcing an OS-assigned port to a Traefik file-provider on startup) — that mechanism existed at one point during this port and was deliberately removed: `global.http-port` is now always a fixed, manually-chosen value, exactly like aria2's own RPC port, with no auto-registration step at all. Set it explicitly for any real deployment.

---

## Running without Docker

Nothing about wis2hauler requires a container. A compiled binary (built with the plain, non-musl target on the host's own libc) or `bun src/main.ts` directly both work fine on any machine with network access to Redis and aria2:

```bash
bun build --compile src/main.ts --outfile wis2hauler
./wis2hauler /path/to/configuration.yml
# or, without a compile step:
bun src/main.ts /path/to/configuration.yml
```

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
