# 01 — Single node, download only

The smallest useful deployment: one wis2hauler process, one aria2, one
standalone Redis-compatible store (Valkey here), all on one host via
Docker Compose. It subscribes, downloads, and cleans up after itself —
nothing is republished anywhere.

## What it runs

`global.roles: SUBSCRIBER,DOWNLOADER,CLEANER,REPORTER` — everything
except `REPLAYER` (no historical-replay endpoint in this example).

- **SUBSCRIBER** connects to two WIS2 Global Brokers (`globalbroker.meteo.fr`,
  `globalbroker.inmet.gov.br`) and, as a concrete demo topic, subscribes to
  Japan Meteorological Agency data republished via the Global Cache
  (`cache/a/wis2/jp-jma-gts-to-wis2/#`), skipping anything under
  `experimental/#`. Swap the whitelist for whatever centre/topic you
  actually need.
- **DOWNLOADER** pulls matching notifications and downloads the
  referenced files through aria2 into `./downloads`, named by topic
  (`rename-to: "topic"`).
- **CLEANER** deletes a file `600` seconds (10 minutes) after it lands —
  turn `cleaner.keep-in-cache` up if you want to actually look at what
  landed before it's swept.
- **REPORTER** exposes Prometheus metrics at `http://localhost:8080/metrics`.

### Download only — no publish

`global.local-broker` is not set. That's what makes this "download
only": with no local broker configured, neither SUBSCRIBER's
publish-only outcomes nor DOWNLOADER's completion notifications get
republished anywhere — downloaded files are just written to
`./downloads` and left there (until CLEANER removes them) for whatever
you point at that directory externally. This is a perfectly normal,
non-degraded deployment shape, not a stripped-down one — see
[`../../docs/configuration-and-roles.md`](../../docs/configuration-and-roles.md#globallocal-broker--optional)
for what changes once you *do* add a local broker (the next example in
this series).

## Running it

This compose file joins an external Docker network so it can be
composed alongside other examples/services without them fighting over
a default network. Create it once, before the first run:

```bash
docker network create wis2hauler
```

Then, prepare the directories (the top-level directory is wherever is convenient):

```bash
mkdir -p mkdir hauler hauler/downloads hauler/logs
docker compose -f wis2hauler.yml up -d
```

Check it's alive:

```bash
curl http://localhost:8080/metrics
cd ./logs
ls -ail
cd ../downloads
ls -lR
```

Files will start appearing under `./downloads` as matching notifications
arrive on the subscribed topic (and disappear again after 10 minutes,
per `cleaner.keep-in-cache`).

Logging information will available in `./logs`.

## Notes

- `RPC_SECRET`/`downloader.aria-secret` are both set to `secret` here
  purely so the example runs out of the box — pick a real secret for
  anything beyond a local test.
- `global-broker`/`mqtt` credentials shown (`everyone`/`everyone`) are
  the WIS2 Global Broker demo/public credentials, not specific to this
  deployment.
- `global.global-cache: false` here is unrelated to the "no publish"
  behavior above — it only matters once a local broker *is* configured
  (see the doc link above); left explicit for clarity.
