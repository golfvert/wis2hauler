// Unconditional, always-on heartbeat writer -- one per replica process,
// run concurrently with whatever role-specific loops this replica also
// carries (see main.ts's RoleRunners: a `heartbeat` entry runs
// alongside the sequential per-role blocks, not gated behind any
// specific role). Ported from the Setup tab's "Ready ?" -> "Configuration"
// (ua_hb_build) -> "HSET" (ua_hb_hset) chain, fired by "Heartbeat"
// (ua_hb_inject, onceDelay 3s, repeat every 2s) -- confirmed against
// flows.json this session; every replica writes its own `<worker>:*`
// fields regardless of which roles it carries, so downstream Elect
// polls (elector.ts) can see it.
import type { ElectionStore } from './store.ts';
import { type HeartbeatRoles, buildHeartbeatFields } from './elect.ts';

// "Heartbeat" inject node: onceDelay 3s, repeat 2s.
export const HEARTBEAT_ONCE_DELAY_MS = 3000;
export const HEARTBEAT_INTERVAL_MS = 2000;

export interface HeartbeatDeps {
	store: ElectionStore;
	worker: string;
	uuid: string;
	roles: HeartbeatRoles;
	s3: boolean;
	topics: readonly (string | { topic: string; qos?: number })[];
	warn: (message: string) => void;
}

export async function runHeartbeatLoop(
	deps: HeartbeatDeps,
	signal: AbortSignal,
	sleep: (ms: number) => Promise<void>,
): Promise<void> {
	await sleep(HEARTBEAT_ONCE_DELAY_MS);
	while (!signal.aborted) {
		try {
			const fields = buildHeartbeatFields(deps.worker, deps.uuid, deps.roles, deps.s3, deps.topics);
			await deps.store.writeHeartbeat(fields);
		} catch (err) {
			deps.warn(`heartbeat write failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		await sleep(HEARTBEAT_INTERVAL_MS);
	}
}
