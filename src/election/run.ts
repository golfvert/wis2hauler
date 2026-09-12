// Top-level wiring for the always-on heartbeat writer -- ONE per
// replica process, run unconditionally and CONCURRENTLY alongside
// whatever role-specific loops this replica also carries (see
// ../main.ts's RoleRunners: `heartbeat` is not gated behind any role
// check -- every replica writes its own `<worker>:*` fields into the
// shared election hash regardless of which roles it carries, per the
// Setup tab's "Ready ?" gate: config_valid && process-mode==='run',
// no role condition -- see heartbeat.ts's own header).
import type { Config, Role } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection } from '../redis/ioredis-store.ts';
import { IoredisElectionStore } from '../redis/ioredis-election-store.ts';
import { runHeartbeatLoop, type HeartbeatDeps } from './heartbeat.ts';

export interface HeartbeatTopic {
	topic: string;
	qos: number;
}

/**
 * The Setup tab's "Configuration" change node (5ebe61e8fc4d96df, part
 * of the Subscriber-role init chain -- fed by the "Subscriber" link-in,
 * so global.topic is only ever set on a replica that carries
 * SUBSCRIBER). Ported field-for-field: the effective whitelist, each
 * entry trimmed and wrapped with `{topic, qos}`, PLUS -- when
 * subscriber.mqtt['global-replay'] is a non-null string -- one
 * synthetic "replay/a/wis2/<globalReplay>/<uuid>/#" topic appended at
 * the same qos.
 *
 * A replica without a subscriber section (doesn't carry SUBSCRIBER)
 * returns [] here, matching heartbeat.ts's `$exists($globalContext("topic"))
 * ? ... : []` on the original -- there's nothing to derive it from.
 */
export function deriveHeartbeatTopics(config: Config, uuid: string): HeartbeatTopic[] {
	const sub = config.subscriber;
	if (!sub) return [];

	const qos = typeof sub.mqtt.qos === 'number' ? sub.mqtt.qos : 0;
	const globalReplay = typeof sub.mqtt['global-replay'] === 'string' ? sub.mqtt['global-replay'] : null;
	const topics = globalReplay === null ? sub.mqtt.whitelist : [...sub.mqtt.whitelist, `replay/a/wis2/${globalReplay}/${uuid}/#`];

	return topics.map((t) => ({ topic: t.trim(), qos }));
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runHeartbeat(config: Config, _debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string): Promise<void> {
	const roles = config.global.roles.split(',').map((r) => r.trim()) as Role[];
	const worker = config.global.worker;

	const redisConn = createRedisConnection(config.global.redis);
	const store = new IoredisElectionStore(redisConn);

	const deps: HeartbeatDeps = {
		store,
		worker,
		uuid: processUuid,
		roles: {
			subscriber: roles.includes('SUBSCRIBER'),
			downloader: roles.includes('DOWNLOADER'),
			cleaner: roles.includes('CLEANER'),
			reporter: roles.includes('REPORTER'),
			replayer: roles.includes('REPLAYER'),
		},
		// global.get('rename-to-s3') -- same derivation as cleaner/run.ts's scheduleConfig.renameToS3.
		s3: config.downloader?.['rename-to'] === 's3',
		topics: deriveHeartbeatTopics(config, processUuid),
		warn: (m) => log.warn(`HEARTBEAT: ${m}`),
	};

	log.log('HEARTBEAT: starting');
	await runHeartbeatLoop(deps, signal, defaultSleep);
	log.log('HEARTBEAT: shutdown signalled, closing connection');

	await redisConn.quit();
}
