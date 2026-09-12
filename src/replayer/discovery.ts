// The Replayer tab's "Get sub" function node (5f4432882ae42dfb) --
// ported field-for-field. Reads the SAME shared election hash
// (wis2gc:configuration, ../election/elect.ts's parseElectionHash --
// reused here rather than re-implemented, since it's the identical
// flat-array -> { worker: { field: value } } parse every "Elect"
// function also does) to discover every distinct, not-already-replayed
// topic currently subscribed to across the whole deployment.
//
// Uses its OWN 60-second alive threshold -- TOPIC_DISCOVERY_ALIVE_MS
// below, DELIBERATELY DISTINCT from ../election/elect.ts's
// ELECTION_ALIVE_MS (8000ms, used for primary/secondary election
// itself). Ported exactly as coded: a worker is "alive" for topic
// discovery purposes as long as its heartbeat is under 60s old, a much
// more generous window than the 8s used to decide who's primary.
import { parseElectionHash } from '../election/elect.ts';

export const TOPIC_DISCOVERY_ALIVE_MS = 60000;

const REPLAY_PREFIX = 'replay/a/wis2';

export function discoverReplayTopics(flatElectionHash: readonly string[], now: number): string[] {
	const workers = parseElectionHash(flatElectionHash);
	const all: string[] = [];

	for (const info of Object.values(workers)) {
		if (now - parseFloat(info.ts ?? '0') >= TOPIC_DISCOVERY_ALIVE_MS) continue;
		if (!info.topics) continue;

		let parsed: unknown;
		try {
			parsed = JSON.parse(info.topics);
		} catch {
			continue;
		}
		if (!Array.isArray(parsed)) continue;

		for (const item of parsed) {
			const topic = item && typeof item === 'object' ? (item as { topic?: unknown }).topic : item;
			if (typeof topic === 'string' && !topic.startsWith(REPLAY_PREFIX)) all.push(topic);
		}
	}

	return [...new Set(all)];
}
