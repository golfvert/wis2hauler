// Top-level wiring for a live SUBSCRIBER role: subscribes the
// configured whitelist on each already-connected GB1/GB2 client,
// wires each message through ingest.ts into the raw stream, and polls
// the XREAD consumer loop (consumer.ts) every second until the given
// AbortSignal fires, publishing through the already-connected
// PUB1/PUB2 clients it's handed. This is what main.ts calls when
// global.roles includes SUBSCRIBER -- see main.ts's RoleRunners for
// how this gets swapped for a fake in tests.
//
// DELIBERATE CHANGE, 2026-09-12: this used to open and close its own
// GB1/GB2 and PUB1/PUB2 connections. the maintainer's call ("main.ts being the
// 'orchestrator' should manage all connection for both up and down"):
// main() now opens every MQTT connection this process needs -- GB1/GB2
// inside its own SUBSCRIBER try/catch (so a connect failure there
// still only fails the SUBSCRIBER role, not the whole process), and
// PUB1/PUB2 ONCE, shared with DOWNLOADER when both roles are active on
// the same replica (they used to each open their own, wasteful and
// the root of a real client-id collision -- see mqtt/client.ts's
// connectMqtt doc comment) -- and closes all of them once every role
// has settled. This runner just uses what it's handed.
//
// Wired field-for-field against nodered/flows.json's Subscriber tab:
// GB2 gets a fixed 2s per-message ingest delay GB1 doesn't (see
// ingest.ts), and the consumer loop polls (not blocks) once a second
// starting from the very beginning of the raw stream, matching the
// original's "Poll" inject node + "Read" -> "XREAD" (no BLOCK) chain
// and the Setup tab's lastMqttId = "0-0" initialization.
//
// The original ALSO had GB1's blacklist gain an extra global-cache
// exemption rule GB2's didn't -- an asymmetry with no documented
// rationale anywhere, traced to a stray typo between two near-duplicate
// Node-RED node names ("Black & GRep" vs "Black &. GRep"), the
// signature of an incomplete copy-paste rather than intentional
// design. FIXED 2026-09-19 (the maintainer, after this was flagged and
// confirmed to have no rationale): both connections now use the exact
// same effectiveBlacklist below, computed once and shared -- this is a
// deliberate departure from the literal port, not an oversight.
//
// NOT a port, added 2026-09-19 (same day, separate change): both
// connections also get ingest.ts's ORIGIN_CORE_BLACKLIST_RULE /
// ORIGIN_METADATA_BLACKLIST_RULE appended whenever global-cache mode
// is off -- see that file's doc comment for why (replaces the old
// config-time whitelist/blacklist rewrite, which a broad wildcard
// subscription could bypass entirely). Folded into the same
// effectiveBlacklist below, so GB1 and GB2 are symmetric on both
// safeguards now, not just the new one.
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection, IoredisStore } from '../redis/ioredis-store.ts';
import type { MqttLike } from '../mqtt/types.ts';
import {
	createIngestHandler,
	createIngestStats,
	defaultSleep,
	RECOMMENDED_TOPIC_BLACKLIST_RULE,
	ORIGIN_CORE_BLACKLIST_RULE,
	ORIGIN_METADATA_BLACKLIST_RULE,
} from './ingest.ts';
import { runConsumerLoop, type ConsumerDeps } from './consumer.ts';
import { createSourceLogger, type LevelGate } from '../logging/logger.ts';
import type { LogSink } from '../logging/sink.ts';

// GB2's fixed per-message ingest delay (flows.json node 68d4df2b43657354).
const GB2_INGEST_DELAY_MS = 2000;

export async function runSubscriber(
	config: Config,
	debug: DebugController,
	log: typeof console,
	signal: AbortSignal,
	upstreamClients: MqttLike[],
	publishClients: MqttLike[],
	logSink?: LogSink,
	gate?: LevelGate,
): Promise<void> {
	const sub = config.subscriber;
	if (!sub) throw new Error('runSubscriber called without a subscriber: config section (global.roles includes SUBSCRIBER but validation should have caught this)');
	const queue = config.global.queue;
	if (!queue) throw new Error('runSubscriber called without global.queue (validation should have caught this)');

	const isDebugEnabled = () => debug.has('SUBSCRIBER');
	const globalCacheMode = config.global['global-cache'] ?? false;
	const centreId = config.global['centre-id'] ?? '';

	const redisConn = createRedisConnection(config.global.redis);
	const store = new IoredisStore(redisConn);

	const whitelist = sub.mqtt.whitelist;
	const baseBlacklist = sub.mqtt.blacklist ?? [];
	// One shared blacklist for BOTH GB1 and GB2 -- see this file's
	// header comment. global-cache mode on: add the recommended-topic
	// exemption (this replica IS a Global Cache, so recommended data is
	// meant to come in via the separate credentials-based pull path, not
	// this broadcast subscription). global-cache mode off: add the
	// core/metadata safeguard instead (this replica is NOT a Global
	// Cache, so it must never pull core/metadata straight from origin --
	// see ingest.ts's doc comment on those two constants). The two cases
	// are mutually exclusive by construction (one gate on the same
	// globalCacheMode), so this never applies both.
	const effectiveBlacklist = globalCacheMode
		? [...baseBlacklist, RECOMMENDED_TOPIC_BLACKLIST_RULE]
		: [...baseBlacklist, ORIGIN_CORE_BLACKLIST_RULE, ORIGIN_METADATA_BLACKLIST_RULE];

	// Informational, once per SUBSCRIBER startup -- not per connection --
	// so this is never a silent behavior change: with global-cache mode
	// off, every GB1/GB2 subscription (however broadly its whitelist is
	// written) will still never see origin/.../data/core/... or
	// origin/.../metadata/... notifications; only origin/.../data/
	// recommended/... (and anything under cache/...) gets through. The
	// configured whitelist itself is left exactly as written -- this is
	// no longer a config-rewrite, see ingest.ts's doc comment on why.
	if (!globalCacheMode) {
		log.log(
			'SUBSCRIBER: global.global-cache is not set -- ignoring any origin/.../data/core/... or origin/.../metadata/... ' +
				'notification regardless of the configured whitelist (only origin/.../data/recommended/... and cache/... are processed); ' +
				'the whitelist/blacklist themselves are not being modified',
		);
	}

	// Shared across both GB1/GB2 handlers below -- see ingest.ts's own
	// IngestDeps.receivedLog doc comment; each connection's own line
	// carries its `source` (GB1/GB2) so one logger/file still tells them apart.
	const receivedLog = logSink && gate ? createSourceLogger('Received', logSink, gate, 'SUBSCRIBER') : undefined;
	// See ingest.ts's own IngestDeps.filterLog doc comment (2026-09-20,
	// the data_id tracing effort) -- shared across GB1/GB2 the same way
	// receivedLog is, for the same reason.
	const filterLog = logSink && gate ? createSourceLogger('Filter', logSink, gate, 'SUBSCRIBER') : undefined;

	for (let i = 0; i < upstreamClients.length; i++) {
		const label = `GB${i + 1}`;
		const client = upstreamClients[i]!;
		await client.subscribe(whitelist);
		const stats = createIngestStats();
		const handler = createIngestHandler(
			{
				store,
				queue,
				blacklist: effectiveBlacklist,
				sourceLabel: label,
				preDelayMs: i === 0 ? 0 : GB2_INGEST_DELAY_MS,
				sleep: defaultSleep,
				now: () => Date.now(),
				log,
				isDebugEnabled,
				receivedLog,
				filterLog,
			},
			stats,
		);
		client.onMessage((topic, payload) => {
			void handler(topic, payload).catch((err) => log.error(`[${label}] ingest error on ${topic}: ${err instanceof Error ? err.message : String(err)}`));
		});
		log.log(`SUBSCRIBER: ${label} subscribed to ${whitelist.length} whitelist pattern(s)`);
	}

	const consumerDeps: ConsumerDeps = {
		store,
		queue,
		overridelist: sub.mqtt.overridelist,
		weightSources: sub['weight-sources'] ? new Map(Object.entries(sub['weight-sources'])) : undefined,
		// DEFAULT_WEIGHT_DELAY_SECONDS: no maintainer-specified default was
		// ever set for this scale parameter being entirely absent from
		// config -- 8s matches the example the maintainer approved when
		// this mechanism was designed (2026-09-20).
		weightDelaySeconds: sub['weight-delay-seconds'] ?? 8,
		// DEFAULT_WEIGHT_DELAY_MAX_SECONDS: added 2026-09-20 after a
		// production incident (see order-links.ts's computeDelaySeconds()
		// doc comment) -- 120s is a safe default even for well-behaved
		// configs (weight roughly 1, weight-delay-seconds around 8: the
		// cap essentially never triggers there), while bounding the worst
		// case for a misconfigured or deliberately low weight.
		weightDelayMaxSeconds: sub['weight-delay-max-seconds'] ?? 120,
		random: Math.random,
		globalCacheMode,
		centreId,
		publishClients,
		log,
		isDebugEnabled,
		sleep: defaultSleep,
		now: () => new Date(),
		decisionLog: logSink && gate ? createSourceLogger('Decision', logSink, gate, 'SUBSCRIBER') : undefined,
		publishLog: logSink && gate ? createSourceLogger('Publish', logSink, gate, 'SUBSCRIBER') : undefined,
		duplicateLog: logSink && gate ? createSourceLogger('Duplicate', logSink, gate, 'SUBSCRIBER') : undefined,
	};

	log.log('SUBSCRIBER: consumer loop starting');
	await runConsumerLoop(consumerDeps, signal);
	log.log('SUBSCRIBER: shutdown signalled');

	// upstreamClients/publishClients are NOT closed here -- main.ts (the
	// orchestrator) owns their whole lifecycle, including end(), since
	// publishClients may be shared with a concurrently-running
	// DOWNLOADER on this same replica.
	await store.quit();
}
