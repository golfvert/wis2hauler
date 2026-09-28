# 02, phase 3 — front it with Traefik

Adds a reverse proxy in front of [phase 2](../phase-2-publish/)'s
`wis2hauler-sub`, `wis2hauler-downloader`, and `caddy` — as a genuinely
separate Compose stack, with **no changes to phase 2 at all**.

## Why a separate compose file, and why the file provider

docs/deployment.md's own "Reverse proxy / Traefik" section shows the
more common pattern: Docker-label discovery, with the labels living
directly on the target service in *its* compose file. That's simpler
when you own that file and are fine editing it. Here the point was to
add Traefik on top of an already-built phase 2 without touching it, so
this uses Traefik's **file provider** instead — plain static routing
config, naming phase 2's containers by their Compose service name
(`wis2hauler-sub`, `wis2hauler-downloader`, `caddy`), resolved over the
`wis2hauler` external network both stacks share. Add or remove this
layer independently of phase 2, any time.

## What it routes

`dynamic/` holds one file per backend — Traefik's file provider watches
the whole directory (`--providers.file.directory=/etc/traefik/dynamic`)
and merges every file in it, so this is purely an organizational
choice, not a functional one; a single combined file would behave
identically. One file per container keeps each route self-contained
(its router, its strip-prefix middleware, and its service definition
together) and means adding a fourth backend later is a new file, not an
edit to a shared one.

| File | Path | Backend | What it is |
|---|---|---|---|
| `dynamic/wis2hauler-sub.yml` | `/sub/*` | `wis2hauler-sub:8080` | REPORTER metrics + admin API for the SUBSCRIBER/CLEANER/REPORTER instance |
| `dynamic/wis2hauler-downloader.yml` | `/downloader/*` | `wis2hauler-downloader:8080` | admin API for the DOWNLOADER instance |
| `dynamic/downloads.yml` | `/downloads/*` | `caddy:80` | the browsable downloaded-files listing from phase 2 |

Each router strips its prefix before forwarding, same pattern as the
docs' own `PathPrefix` + `stripprefix` example, just expressed as file
config instead of labels.

## Running it

**Phase 2 must already be up** — this stack only routes to it, it
doesn't start any of it:

```bash
cd ../phase-2-publish
docker compose -f wis2hauler.yml up -d
docker compose -f mosquitto.yml up -d
docker compose -f caddy.yml up -d
cd -
```

Then, from this directory:

```bash
docker compose -f traefik.yml up -d
```

Try it:

```bash
curl http://localhost/sub/metrics
curl http://localhost/downloader/get
open http://localhost/downloads/
```

## Note on the dashboard

`--api.insecure=true` (mapped to `http://localhost:8082`) exposes
Traefik's dashboard with no authentication at all — fine for poking at
locally, never for anything reachable beyond your own machine. For
anything real, put the dashboard behind its own auth (or don't expose
it) rather than `--api.insecure`.

In a real deployment you'd also add a `Host(...)` rule alongside each
`PathPrefix` (see docs/deployment.md's `Host(\`wis2.example.org\`)`
example) and TLS at the entrypoint — both skipped here since this is
meant to run against `localhost`.
