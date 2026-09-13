// Top-level wiring for a live REPORTER role: connects to Redis (one
// command connection, one dedicated psubscribe connection -- same
// reasoning as cleaner/run.ts), builds the prom-client registry, runs
// its 2 concurrent loops, and registers 2 routes on the shared HTTP
// router (../http/router.ts -- main.ts owns the actual Bun.serve()
// instance, since Replayer registers its own /replayer/primary route
// on the SAME instance/port, per the maintainer's explicit decision this session
// -- "nodered offers one port... for all HTTP access") until the given
// AbortSignal fires:
//   - Election (../election/elector.ts, shared primitive, 10s poll,
//     role="reporter").
//   - Report processing (kv.ts/route.ts/hash-error.ts/stats.ts) --
//     event-driven off the "Reporter" redis-in psubscribe node
//     (4dda7432857f6b17, pattern "wis2gc:cleaner-reporter:*"), gated
//     on primary only (a94892868ef6cf36).
//   - HashStat/Metrics window clock (window.ts/metrics.ts) -- a
//     self-scheduling 30s clock, started unconditionally (see this
//     file's own comment at the windowLoop definition for why this
//     deviates from the original's one-shot "Reporter ?" primary gate,
//     found 2026-09-11: the maintainer -- "Still empty. After restart.").
//   - Routes: GET /reporter/primary (200 if primary, 404 otherwise --
//     9ca6f5b65925e91b), POST /caddy (GeoIP + active-IP tracking,
//     gated on role-active only, NOT primary -- 0acb04c88a3ca878).
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection } from '../redis/ioredis-store.ts';
import { IoredisReporterStore } from '../redis/ioredis-reporter-store.ts';
import { IoredisElectionStore } from '../redis/ioredis-election-store.ts';
import { runElectionLoop } from '../election/elector.ts';
import { transformKV } from './kv.ts';
import { classifyReportType } from './route.ts';
import { buildHashOrErrorOp } from './hash-error.ts';
import { buildStatsWrite } from './stats.ts';
import { STATS_WINDOW_SECONDS, computeStatsWindowKey, msUntilNextWindowBoundary } from './window.ts';
import { aggregateMetrics } from './metrics.ts';
import { buildBytesOp, buildFilesOp, buildIpsOp, deriveCountry, extractGranuleRecord, parseCaddyLogEntry } from './caddy.ts';
import { applyCounterOp, applyGaugeOp, createReporterMetrics } from './prom.ts';
import { cleanerReporterKey } from '../wis2/redis-keys.ts';
import type { HttpRouter } from '../http/router.ts';
import path from 'node:path';

// "Start" inject: onceDelay 2s, once (no repeat).
const HASHSTAT_START_DELAY_MS = 2000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runReporter(config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string, router: HttpRouter): Promise<void> {
	// geoip-lite reads its .dat files as a MODULE-LEVEL side effect (its
	// lib/geoip.js unconditionally calls preload()/preload6() at the bottom
	// of the file) using a directory it resolves off `__dirname` at the
	// time the module is evaluated. Bun's `--compile` bakes `__dirname` in
	// as the literal path it had on the machine that BUILT the binary (e.g.
	// /home/runner/work/wis2hauler/wis2hauler/node_modules/geoip-lite/data
	// on the CI runner) -- not a path inside the compiled executable. A
	// top-level `import geoipLite from 'geoip-lite'` therefore used to
	// crash EVERY compiled binary at startup with ENOENT, on every
	// platform, regardless of which roles were even configured, since
	// main.ts imports this module unconditionally (found live, 2026-09-13:
	// the maintainer's first real Docker deployment test died before even
	// REPORTER's election loop started).
	//
	// Fixed two ways:
	//   1. Load geoip-lite lazily, here, only when REPORTER actually runs
	//      -- a deployment that never enables REPORTER never touches it.
	//   2. Point GEODATADIR (an env override geoip-lite's own path
	//      resolution already honors -- see its geodatadir computation)
	//      at a RUNTIME-computed default: the `geoip-data` folder shipped
	//      next to the ACTUAL running executable (`process.execPath`, a
	//      real runtime value, unlike `__dirname`). See Dockerfile (bakes
	//      the data in at exactly that path) and docs/deployment.md (the
	//      standalone-binary case, using the geoip-data.tar.gz release
	//      asset). An operator can still set GEODATADIR themselves to put
	//      the data somewhere else.
	process.env.GEODATADIR ??= path.join(path.dirname(process.execPath), 'geoip-data');
	const { default: geoipLite } = await import('geoip-lite');

	const reportBy = config.global['centre-id'] ?? '';
	const keepIpSeconds = config.reporter?.['keep-ip-address'] ?? 86400;

	const isDebugEnabled = () => debug.has('REPORTER');

	const commandConn = createRedisConnection(config.global.redis);
	const store = new IoredisReporterStore(commandConn);
	const electionStore = new IoredisElectionStore(commandConn);
	const subConn = createRedisConnection(config.global.redis);

	const metrics = createReporterMetrics();
	const state = { primary: false };

	// -- Election --
	const electionLoop = runElectionLoop(
		{
			store: electionStore,
			role: 'reporter',
			uuid: processUuid,
			onResult: (priority) => {
				state.primary = priority === 'primary';
				if (isDebugEnabled()) log.log(`REPORTER: election -> ${priority}`);
			},
			warn: (m) => log.warn(`REPORTER: ${m}`),
		},
		signal,
		defaultSleep,
	);

	// -- Report processing (K/V -> Type ? -> Hash/Error/Stats) --
	let currentWindowKey: string | null = null;
	const reportChannel = cleanerReporterKey('*');
	subConn.on('pmessage', (_pattern: string, channel: string, message: string) => {
		if (!state.primary) return;
		void (async () => {
			try {
				let flat: unknown[];
				try {
					const parsed: unknown = JSON.parse(message);
					flat = Array.isArray(parsed) ? parsed : [];
				} catch {
					flat = [];
				}
				const record = transformKV(flat);
				const kind = classifyReportType(record.raw.type);
				const topic = typeof record.raw.topic === 'string' ? record.raw.topic : undefined;

				if (kind === 'integrity_fail') {
					applyCounterOp(metrics.integrityFailedTotal, buildHashOrErrorOp(topic, reportBy));
				} else if (kind === 'download_error') {
					applyCounterOp(metrics.downloadedErrorsTotal, buildHashOrErrorOp(topic, reportBy));
				} else if (currentWindowKey) {
					const cmd = buildStatsWrite(currentWindowKey, record);
					await store.writeStatsWindow(cmd);
				}
			} catch (err) {
				log.error(`REPORTER: report processing failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
	});
	await subConn.psubscribe(reportChannel);

	// -- HashStat / Metrics window clock --
	async function runMetricsTick(previousWindowKey: string): Promise<void> {
		try {
			const { comboEntries, srcEntries } = await store.readWindowStats(previousWindowKey);
			const agg = aggregateMetrics(comboEntries, srcEntries, reportBy);
			for (const op of agg.numberOps) applyCounterOp(metrics.numberDownloadTotal, op);
			for (const op of agg.volumeOps) applyCounterOp(metrics.volumeDownloadTotal, op);
			for (const op of agg.delayOps) applyGaugeOp(metrics.delayDownloadSeconds, op);
			for (const op of agg.sourceOps) applyCounterOp(metrics.sourceDownloadTotal, op);
			for (const op of agg.downloadedOps) applyCounterOp(metrics.downloadedTotal, op);
			for (const op of agg.timestampOps) applyGaugeOp(metrics.lastDownloadTimestampSeconds, op);
		} catch (err) {
			log.error(`REPORTER: Metrics tick failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async function runHashStatLoop(): Promise<void> {
		while (!signal.aborted) {
			const waitMs = Math.max(0, msUntilNextWindowBoundary(new Date()));
			await defaultSleep(waitMs);
			if (signal.aborted) break;
			const now = new Date();
			currentWindowKey = computeStatsWindowKey(now);
			const previousWindowKey = computeStatsWindowKey(new Date(now.getTime() - STATS_WINDOW_SECONDS * 1000));
			await runMetricsTick(previousWindowKey);
		}
	}

	// Started unconditionally, NOT gated on state.primary at t=2s.
	//
	// The original's "Reporter ?" gate (9bf83f610940c63a, checked once
	// at the "Start" inject's onceDelay=2s) reads
	// $globalContext("reporter-primary") -- which is only ever set by
	// the SEPARATE Elect chain, itself on its own inject with
	// onceDelay=5s (confirmed against flows.json's eb0000000000a003
	// this session), fed by a heartbeat whose own first write can't
	// land before onceDelay=3s (heartbeat.ts's HEARTBEAT_ONCE_DELAY_MS).
	// So the ORIGINAL's own 2s gate fires strictly before its 5s Elect
	// chain has EVER run even once -- global.reporter-primary is still
	// undefined at that instant, on every single cold start, for every
	// deployment shape, not just the maintainer's. Ported byte-for-byte (a
	// one-shot check of state.primary at the same t=2s mark) that same
	// gate reproduced the exact same dead end: found 2026-09-11 when
	// the maintainer reported /metrics coming back with headers only, still empty
	// after the finishing.ts/consumer.ts independent-steps fix (see the
	// project notes) -- this loop, the ONLY thing that ever calls
	// applyCounterOp/applyGaugeOp for the window-aggregated metrics
	// (wmo_wis2_gc_downloaded_total, last_download_timestamp_seconds,
	// and the monitor_wis2_gc_* number/volume/delay/source counters),
	// was never starting at all, on any restart, permanently for the
	// life of the process -- not a timing flake, a guaranteed miss.
	//
	// Fix: just run this loop on every replica unconditionally --
	// dropping the primary check here doesn't risk double-counting or
	// duplicate writes in a real multi-replica deployment, because the
	// one thing that actually needs single-writer semantics (the
	// report-processing psubscribe handler's store.writeStatsWindow()
	// call, above) is ALREADY independently gated by its own
	// `if (!state.primary) return;`, freshly re-checked on every
	// incoming message rather than snapshotted once at startup. This
	// loop only READS that shared Redis window data and aggregates it
	// into THIS process's own local prom-client Registry -- running it
	// on every replica just means every replica's own /metrics reports
	// the same numbers, which is the behavior Prometheus scraping
	// actually wants anyway.
	const windowLoop = (async () => {
		await defaultSleep(HASHSTAT_START_DELAY_MS);
		await runHashStatLoop();
	})();

	// -- HTTP: /reporter/primary + /caddy + /metrics (registered on the shared router -- see ../http/router.ts's header) --
	router.get('/reporter/primary', () => new Response(null, { status: state.primary ? 200 : 404 }));

	// The original's 11 "prometheus-exporter" nodes (see prom.ts's header)
	// come from the node-red-contrib-prometheus-exporter package, which
	// auto-serves its own GET /metrics on Node-RED's HTTP server with no
	// explicit http-in node in flows.json -- there was nothing to trace,
	// so this never got ported and the registry was built/updated but
	// never actually exposed (found 2026-09-11, the maintainer: "where are
	// published the metrics ?"). Not gated on state.primary, matching
	// that library's own behaviour (it has no primary-awareness at all)
	// -- report-processing above already only updates real values on
	// whichever replica is primary; this just serves whatever this
	// process's registry currently holds, same as the original.
	router.get('/metrics', async () => {
		const body = await metrics.registry.metrics();
		return new Response(body, { headers: { 'Content-Type': metrics.registry.contentType } });
	});

	router.post('/caddy', async (req) => {
		void (async () => {
			try {
				const body: unknown = await req.json();
				const entry = parseCaddyLogEntry(body);
				if (!entry) return;

				const geo = geoipLite.lookup(entry.clientIp);
				const country = deriveCountry(geo);

				const flat = await store.readGranule(entry.uri);
				const granule = extractGranuleRecord(flat);

				applyCounterOp(metrics.userDownloadedFilesTotal, buildFilesOp(granule, country, reportBy));
				applyCounterOp(metrics.userDownloadedBytesTotal, buildBytesOp(granule, country, reportBy));

				const distinctCount = await store.recordActiveIp(entry.clientIp, keepIpSeconds);
				applyGaugeOp(metrics.userDistinctTotal, buildIpsOp(granule, country, reportBy, distinctCount));
			} catch (err) {
				log.error(`REPORTER: Caddy webhook failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
		return new Response('OK', { status: 200 });
	});

	log.log('REPORTER: election + report-processing + hashstat/metrics loops starting');
	await Promise.allSettled([electionLoop, windowLoop]);
	log.log('REPORTER: shutdown signalled, closing connections');

	await subConn.punsubscribe(reportChannel);
	await subConn.quit();
	await store.quit();
}
