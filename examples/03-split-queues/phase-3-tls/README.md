# 03, phase 3 — publish over real TLS via Traefik + Let's Encrypt

Builds on [`phase-2-redundancy`](../phase-2-redundancy/): same 8
wis2hauler instances, same redundancy/broker-diversity setup. Turns
`global.local-broker` back on (all 8 configs) and serves the downloads
at a real public URL, `https://cache.example.com`, with Traefik
terminating TLS via Let's Encrypt's DNS-01 challenge against
Infomaniak's API — rather than `02-split-roles`'s `phase-2-publish`
(plain `http://localhost:8090`) or its `phase-3-traefik` (Traefik
fronting things, but no TLS at all).

`mosquitto` and `caddy` are their own compose files here too, same
reasoning as `02-split-roles`'s `phase-2-publish` — additional tools,
not part of the core hauler/aria2/valkey stack.

## What's new in each `configuration-*.yml`

Every one of the 8 configs now carries:

```yaml
global:
  local-broker:
    - broker: mqtt://mosquitto:1883
```

and every `configuration-downloader-*.yml` additionally carries:

```yaml
downloader:
  download-url: https://cache.example.com
```

**`cache.example.com` is a placeholder** — RFC 2606 reserves
`example.com` precisely so documentation can use it without it
resolving to anything real. Nothing here can actually issue a
certificate for it. Replace every `cache.example.com` (in the
`configuration-downloader-*.yml` files, and in
`dynamic/downloads.yml`'s `Host(...)` rule) with a real domain whose
DNS you manage through Infomaniak, before this will actually work
end-to-end.

## TLS: Traefik + Let's Encrypt + Infomaniak DNS-01

`traefik.yml` adds two entrypoints (`web` on `:80`, redirecting to
`websecure` on `:443`) and a `letsencrypt` certificate resolver using
the DNS-01 challenge, `dnschallenge.provider=infomaniak`. DNS-01 proves
domain ownership by writing a TXT record via Infomaniak's API rather
than serving an HTTP response — works even though nothing here is
reachable from the public internet yet, which HTTP-01 would require.

`dynamic/downloads.yml` routes `Host(\`cache.example.com\`)` on the
`websecure` entrypoint, `tls.certResolver: letsencrypt`, to `caddy:80`
— the same static-file-server-with-directory-browsing `Caddyfile` as
`02-split-roles`'s `phase-2-publish`, just no longer published to the
host directly (contrast that phase's `caddy.yml`): Traefik is the only
way in now.

### The token name

Traefik uses `lego` internally for ACME, and lego's Infomaniak provider
expects the API token as **`INFOMANIAK_ACCESS_TOKEN`** specifically
(confirmed against <https://go-acme.github.io/lego/dns/infomaniak/> —
easy to get wrong, since some other lego providers use an
`_API_TOKEN`-shaped name instead). Per your naming choice, the actual
secret lives in `.env` as `my_dns_enabled_token`; `traefik.yml` maps it
across:

```yaml
environment:
  - INFOMANIAK_ACCESS_TOKEN=${my_dns_enabled_token}
```

Set it up:

```bash
cp .env.example .env
# edit .env, set my_dns_enabled_token=<a real Infomaniak API token scoped to DNS management>
```

`.env` itself is gitignored (repo-wide `.env`/`.env.*` rule); only
`.env.example` (the empty template) is meant to be committed.

### `acme.json`

Traefik's ACME storage file needs to exist with `0600` permissions
before it starts, and this whole `letsencrypt/` directory is gitignored
(it ends up holding real certificate/account data once ACME succeeds —
never meant to be committed):

```bash
mkdir -p letsencrypt
touch letsencrypt/acme.json
chmod 600 letsencrypt/acme.json
```

## Running it

```bash
docker network create wis2hauler   # if it doesn't already exist
mkdir -p downloads logs-sub-1-a logs-sub-1-b logs-down-1-a logs-down-1-b \
         logs-sub-2-a logs-sub-2-b logs-down-2-a logs-down-2-b
docker compose -f wis2hauler.yml up -d
docker compose -f mosquitto.yml up -d
docker compose -f caddy.yml up -d
docker compose -f traefik.yml up -d
```

With a real domain and a real, correctly-scoped Infomaniak token in
place, Traefik should obtain a certificate on first request and:

```bash
curl https://cache.example.com/   # replace with your real domain
```

should return Caddy's browsable file listing over a valid Let's Encrypt
certificate. Check `docker compose -f traefik.yml logs -f traefik` if
it doesn't — ACME failures are logged there, and the dashboard
(`http://localhost:8082`, `--api.insecure=true` — demo only, same
caveat as `02-split-roles`'s `phase-3-traefik`) shows the resolver's
status too.
