// Listens for the expiry of SUBSCRIBER's deadline markers
// (cacheMarkerKey): each one that expires means a notification accepted
// for download was neither completed nor failed within
// global.cache-deadline.
//
// Redis publishes `__keyevent@<db>__:expired` on the node that expires
// the key, and a Cluster has no single place to subscribe, so one
// connection is opened per node (replicas included: only the current
// master emits, which keeps this correct across a failover). Delivery is
// plain pub/sub: an expiry that happens while nobody is listening is not
// replayed. The notification setting is re-applied each time a connection
// is re-established.
import Redis, { Cluster } from 'ioredis';
import type { RedisConfig } from '../config/schema.ts';
import { parseCacheMarkerKey } from '../wis2/redis-keys.ts';

export interface ExpiryListener {
	close(): Promise<void>;
}

const EXPIRED_CHANNEL = '__keyevent@*__:expired';

function parseNode(node: string): { host: string; port: number } {
	const idx = node.lastIndexOf(':');
	return { host: node.slice(0, idx), port: Number(node.slice(idx + 1)) };
}

async function clusterAddresses(config: RedisConfig): Promise<{ host: string; port: number }[]> {
	const probe = new Cluster(config.nodes.map(parseNode), { redisOptions: config.password ? { password: config.password } : {} });
	try {
		if (probe.status !== 'ready') await new Promise<void>((resolve, reject) => {
			probe.once('ready', () => resolve());
			probe.once('error', reject);
		});
		return probe.nodes('all').map((n) => ({ host: String(n.options.host), port: Number(n.options.port) }));
	} finally {
		probe.disconnect();
	}
}

/** Makes sure the node publishes expired-key events (flags E and x), keeping whatever else is enabled. */
export async function ensureNotifications(conn: Pick<Redis, 'config'>, where: string, warn: (message: string) => void): Promise<void> {
	try {
		const reply = (await conn.config('GET', 'notify-keyspace-events')) as string[];
		const current = reply[1] ?? '';
		const missing = (current.includes('E') ? '' : 'E') + (current.includes('x') || current.includes('A') ? '' : 'x');
		if (missing) await conn.config('SET', 'notify-keyspace-events', current + missing);
	} catch (err) {
		warn(`cannot enable notify-keyspace-events on ${where} (set it to include "Ex" in redis.conf): ${err instanceof Error ? err.message : String(err)}`);
	}
}

export async function startExpiryListener(
	config: RedisConfig,
	onExpired: (downloaderId: string) => void,
	warn: (message: string) => void,
): Promise<ExpiryListener> {
	const addresses = config.mode === 'cluster' ? await clusterAddresses(config) : [parseNode(config.nodes[0] ?? '')];
	const connections: Redis[] = [];
	for (const { host, port } of addresses) {
		const conn = new Redis({ host, port, ...(config.password ? { password: config.password } : {}) });
		connections.push(conn);
		conn.on('error', (err) => warn(`expiry listener ${host}:${port}: ${err.message}`));
		await ensureNotifications(conn, `${host}:${port}`, warn);
		// A restarted or failed-over node comes back without the setting: re-apply it
		// on every reconnect (ioredis re-subscribes the pattern by itself).
		conn.on('ready', () => {
			void ensureNotifications(conn, `${host}:${port}`, warn);
		});
		conn.on('pmessage', (_pattern: string, _channel: string, key: string) => {
			const downloaderId = parseCacheMarkerKey(key);
			if (downloaderId) onExpired(downloaderId);
		});
		await conn.psubscribe(EXPIRED_CHANNEL);
	}
	return {
		close: async () => {
			await Promise.allSettled(connections.map((c) => c.quit()));
		},
	};
}
