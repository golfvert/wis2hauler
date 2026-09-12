// Shared leader-election + heartbeat primitive (per C.1's "one shared
// election primitive, called separately per role" decision), ported
// field-for-field against the three near-identical "Elect" function
// nodes found in the Cleaner (105a70cf2b93201b), Reporter
// (eb0000000000a008), and Replayer (aaa9732837560d1b) tabs -- byte-for-
// byte identical apart from their ROLE constant (confirmed by diff),
// plus the Setup tab's shared heartbeat writer ("Configuration"/
// ua_hb_build -> "HSET"/ua_hb_hset) every role-carrying replica runs
// unconditionally, regardless of which specific roles it carries.
//
// Both sides read/write ONE shared hash (wis2gc:configuration, see
// redis-keys.ts's electionHashKey()) keyed "<worker>:<field>" --
// ts/uuid/subscriber/downloader/cleaner/reporter/replayer/s3/topics
// per worker. Every field is written by the SAME replica's own
// heartbeat; every OTHER replica's election read just parses it back.

/** One worker's parsed field set off the shared election hash. */
export type WorkerInfo = Record<string, string>;
export type WorkersByName = Record<string, WorkerInfo>;

/** How long (ms) a heartbeat is considered "alive" for election purposes -- the Elect functions' `now - ts >= 8000` check. */
export const ELECTION_ALIVE_MS = 8000;
/** How long (ms) before a worker's fields are reaped as stale -- `now - ts >= 60000`. */
export const ELECTION_STALE_MS = 60000;

/**
 * Parses the flat HGETALL array into { worker: { field: value } },
 * splitting each key on its LAST ":" (worker ids and field names never
 * contain a stray extra colon in practice, but this mirrors the
 * original's `key.lastIndexOf(':')` literally -- no defensive -1
 * guard, matching the original's own lack of one).
 */
export function parseElectionHash(flat: readonly string[]): WorkersByName {
	const workers: WorkersByName = {};
	for (let i = 0; i < flat.length - 1; i += 2) {
		const key = flat[i]!;
		const value = flat[i + 1]!;
		const colon = key.lastIndexOf(':');
		const worker = key.substring(0, colon);
		const field = key.substring(colon + 1);
		if (!workers[worker]) workers[worker] = {};
		workers[worker]![field] = value;
	}
	return workers;
}

export type ElectionPriority = 'primary' | 'secondary';

/**
 * Election: lowest uuid among ALIVE (ts fresher than 8s) holders of
 * `role` (that worker's "<role>" field === "true"). Ported literally,
 * including the string comparison (`info.uuid < minUuid`) the original
 * uses for "lowest" -- lexicographic on whatever `uuid` string shape a
 * replica generates, not a numeric or UUID-aware comparison.
 */
export function decideElection(workers: WorkersByName, role: string, myUuid: string, now: number): ElectionPriority {
	let minUuid: string | null = null;
	for (const info of Object.values(workers)) {
		if (info[role] !== 'true') continue;
		if (now - parseFloat(info.ts ?? '0') >= ELECTION_ALIVE_MS) continue;
		if (!info.uuid) continue;
		if (minUuid === null || info.uuid < minUuid) minUuid = info.uuid;
	}
	return minUuid !== null && myUuid === minUuid ? 'primary' : 'secondary';
}

/**
 * Reaps every field belonging to a worker whose heartbeat is stale
 * (ts older than 60s) -- returns the flat "<worker>:<field>" list to
 * HDEL, exactly as the original's second output wire builds it.
 */
export function findStaleFields(workers: WorkersByName, now: number): string[] {
	const staleFields: string[] = [];
	for (const [worker, info] of Object.entries(workers)) {
		if (now - parseFloat(info.ts ?? '0') >= ELECTION_STALE_MS) {
			for (const field of Object.keys(info)) staleFields.push(`${worker}:${field}`);
		}
	}
	return staleFields;
}

/**
 * Cleaner-only extra block appended to its own Elect function (not
 * present in Reporter's/Replayer's copies): cluster-wide S3 awareness,
 * fail-safe toward cleaning. `cleaning-needed` is true unless EVERY
 * alive downloader-carrying replica is running S3 mode -- so a mixed
 * or all-local-disk cluster always cleans, and a cluster with no
 * downloader replicas at all (nothing to be fail-safe about) also
 * defaults to true (`!anyDownloader`).
 */
export function computeCleaningNeeded(workers: WorkersByName, now: number): boolean {
	let anyDownloader = false;
	let anyLocal = false;
	for (const info of Object.values(workers)) {
		if (now - parseFloat(info.ts ?? '0') >= ELECTION_ALIVE_MS) continue;
		if (info.downloader === 'true') {
			anyDownloader = true;
			if (info.s3 !== 'true') anyLocal = true;
		}
	}
	return anyLocal || !anyDownloader;
}

/** This replica's own role flags, as the shared heartbeat announces them. */
export interface HeartbeatRoles {
	subscriber: boolean;
	downloader: boolean;
	cleaner: boolean;
	reporter: boolean;
	replayer: boolean;
}

/**
 * Ported from "Configuration"/ua_hb_build: the flat HSET field list
 * this replica writes onto the shared hash every 2s. `topics` is
 * whatever `global.topic` holds in the original -- an array of
 * `{topic, qos}` objects when Subscriber is active (see Subscriber's
 * "Configuration" change node, 5ebe61e8fc4d96df), JSON.stringify'd
 * whole (`$string(...)`) rather than reshaped -- ported the same way
 * here so replayer/topics.ts's "Get sub" reader, which already handles
 * both a bare-string and an {topic,...}-object array element, stays
 * compatible with whatever shape a future Subscriber wiring supplies.
 */
export function buildHeartbeatFields(
	worker: string,
	uuid: string,
	roles: HeartbeatRoles,
	s3: boolean,
	topics: readonly (string | { topic: string; qos?: number })[],
): string[] {
	return [
		`${worker}:ts`,
		String(Date.now()),
		`${worker}:uuid`,
		uuid,
		`${worker}:subscriber`,
		String(roles.subscriber),
		`${worker}:downloader`,
		String(roles.downloader),
		`${worker}:cleaner`,
		String(roles.cleaner),
		`${worker}:reporter`,
		String(roles.reporter),
		`${worker}:replayer`,
		String(roles.replayer),
		`${worker}:s3`,
		String(s3),
		`${worker}:topics`,
		JSON.stringify(topics),
	];
}
