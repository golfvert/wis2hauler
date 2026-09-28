# 02, phase 2 — publish locally + serve files via Caddy

Builds on the base [`02-split-roles`](../) example: same SUBSCRIBER/
CLEANER/REPORTER + DOWNLOADER split, same two topics, same aria2. Adds
a local MQTT broker and turns on republishing, plus Caddy to give the
downloaded files actual clickable links.

`mosquitto` and `caddy` are deliberately kept in their own compose
files (`mosquitto.yml`, `caddy.yml`), separate from `wis2hauler.yml` —
they're additional tools bolted onto the pipeline (one via
`global.local-broker`, one as the `download-url` target), not part of
the core hauler/aria2/valkey stack, and each can be brought up, torn
down, or swapped out on its own. All three compose files share the
same external `wis2hauler` network, so containers reach each other by
service name (`mosquitto`, `caddy`) regardless of which file started
them — same pattern phase 3 uses for Traefik.

## What's new

### `global.local-broker` — republishing turned on

Both `configuration-sub.yml` and `configuration-downloader.yml` now
carry:

```yaml
global:
  local-broker:
    - broker: mqtt://mosquitto:1883
```

Per [`global.local-broker`](../../../docs/configuration-and-roles.md#globallocal-broker--optional):
with this set, SUBSCRIBER's publish-only outcomes and DOWNLOADER's
completion notifications both get republished to it — where the base
example silently skipped that step entirely (no local broker
configured there at all). `mosquitto` is a plain demo broker: anonymous
access, no persistence, no TLS (see `mosquitto.conf`) — add
authentication before running this anywhere network-reachable.

Watch it happen live from the host:

```bash
docker run --rm --network wis2hauler eclipse-mosquitto:2.0.20 \
  mosquitto_sub -h mosquitto -t '#' -v
```

(or `mosquitto_sub -h localhost -t '#' -v` from a host that already has
a local mosquitto client, since port `1883` is also published to the
host).

### `downloader.download-url` — now required, and served by Caddy

Setting `local-broker` makes `download-url` required too (see
[`downloader.download-url`](../../../docs/configuration-and-roles.md#downloaderdownload-url--required-only-when-globallocal-broker-is-configured) —
with nothing to republish to, it was optional; with something to
republish to, DOWNLOADER needs a real URL to build the republished
WNM's link from). `Caddyfile` here just serves `./downloads` (the exact
same directory aria2 and wis2hauler write into) with directory browsing
on, so `http://localhost:8090` is both what gets embedded in republished
notifications and a browsable index of everything downloaded so far —
open it in a browser and click through.

`http://localhost:8090` only works because this is running on one
machine for the demo. In a real deployment `download-url` has to be
whatever URL is actually reachable by whoever receives the republished
notification — a real public hostname, not `localhost`.

### Not included here: Caddy → REPORTER stats webhook

REPORTER also exposes `POST /caddy` (see
[`docs/source-overview.md`](../../../docs/source-overview.md)'s
`caddy.ts` entry) — a webhook that, if Caddy's access log is shipped to
it as `[{"client_ip": "...", "uri": "..."}]`, feeds per-file/per-country
download stats into REPORTER's metrics. This example doesn't wire that
up (it needs a log-shipping piece — e.g. Caddy's own JSON access log
plus something to reshape and POST each line — that's a deployment
choice of its own, not something this Caddyfile assumes for you). Worth
knowing it exists if you want download analytics; a candidate for a
later example.

## Running it

Same external network as the rest of this example series:

```bash
docker network create wis2hauler   # if it doesn't already exist
```

From this directory, bring up all three stacks (order doesn't matter —
they don't depend on each other at startup, only at runtime):

```bash
mkdir -p downloads logs-sub logs-downloader
docker compose -f wis2hauler.yml up -d
docker compose -f mosquitto.yml up -d
docker compose -f caddy.yml up -d
```

```bash
curl http://localhost:8080/metrics   # wis2hauler-sub
open http://localhost:8090           # browse downloaded files via Caddy
```

Tear down just one piece independently of the others, e.g. to try a
different broker image:

```bash
docker compose -f mosquitto.yml down
```
