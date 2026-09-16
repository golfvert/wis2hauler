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
// ingest.ts), GB1's blacklist gets an extra global-cache exemption
// rule GB2's doesn't (also ingest.ts), and the consumer loop polls
// (not blocks) once a second starting from the very beginning of the
// raw stream, matching the original's "Poll" inject node + "Read" ->
// "XREAD" (no BLOCK) chain and the Setup tab's lastMqttId = "0-0"
// initialization.
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection, IoredisStore } from '../redis/ioredis-store.ts';
import type { MqttLike } from '../mqtt/types.ts';
import { createIngestHandler, createIngestStats, defaultSleep, RECOMMENDED_TOPIC_BLACKLIST_RULE } from './ingest.ts';
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
	// GB1 only -- see ingest.ts's header comment on the GB1/GB2 blacklist asymmetry.
	const gb1Blacklist = globalCacheMode ? [...baseBlacklist, RECOMMENDED_TOPIC_BLACKLIST_RULE] : baseBlacklist;

	// Shared across both GB1/GB2 handlers below -- see ingest.ts's own
	// IngestDeps.receivedLog doc comment; each connection's own line
	// carries its `source` (GB1/GB2) so one logger/file still tells them apart.
	const receivedLog = logSink && gate ? createSourceLogger('Received', logSink, gate, 'SUBSCRIBER') : undefined;

	for (let i = 0; i < upstreamClients.length; i++) {
		const label = `GB${i + 1}`;
		const client = upstreamClients[i]!;
		await client.subscribe(whitelist);
		const stats = createIngestStats();
		const handler = createIngestHandler(
			{
				store,
				queue,
				blacklist: i === 0 ? gb1Blacklist : baseBlacklist,
				sourceLabel: label,
				preDelayMs: i === 0 ? 0 : GB2_INGEST_DELAY_MS,
				sleep: defaultSleep,
				now: () => Date.now(),
				log,
				isDebugEnabled,
				receivedLog,
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
		priorityGlobalCache: sub['priority-global-cache'],
		globalCacheMode,
		centreId,
		publishClients,
		log,
		isDebugEnabled,
		sleep: defaultSleep,
		now: () => new Date(),
		orderLinksLog: logSink && gate ? createSourceLogger('Order links', logSink, gate, 'SUBSCRIBER') : undefined,
		decisionLog: logSink && gate ? createSourceLogger('Decision', logSink, gate, 'SUBSCRIBER') : undefined,
		publishLog: logSink && gate ? createSourceLogger('Publish', logSink, gate, 'SUBSCRIBER') : undefined,
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
