// Reorders a WNM's links (canonical/update first) and classifies an
// incoming message by topic so the pipeline knows whether — and how
// long — to stagger it before the content-dedup claim race (see
// dedup.ts). Ported from the Node-RED "Order links" function node
// (Subscriber tab).
//
// The staggering exists because the same content can arrive via
// multiple paths (the true origin, plus zero or more Global Cache
// repeaters) and, rather than coordinate explicitly, the original
// design just lets the origin/highest-priority copy race ahead
// unstaggered while lower-priority cache copies wait progressively
// longer before attempting the SETNX claim in dedup.ts — so in the
// common case the "best" copy wins the claim and everything else
// naturally falls into the "someone already claimed this" branch.
import type { Wnm } from '../wis2/wnm.ts';

export function reorderLinks(wnm: Wnm): Wnm {
	const priority = wnm.links.filter((l) => l.rel === 'canonical' || l.rel === 'update');
	const rest = wnm.links.filter((l) => l.rel !== 'canonical' && l.rel !== 'update');
	return { ...wnm, links: [...priority, ...rest] };
}

export type TopicClassification =
	| { kind: 'origin' } // a true origin/a/wis2/... topic — processed unstaggered
	| { kind: 'cache-unprioritized' } // cache/a/wis2/... but no priority-global-cache configured — treated the same as origin (unstaggered)
	| { kind: 'cache'; position: number } // cache/a/wis2/... from a centre at this 0-based position in priority-global-cache
	| { kind: 'ignore' }; // neither pattern matched, or a cache message with no/unrecognized global-cache label — drop

// Delay (seconds) applied before the claim race, indexed by
// TopicClassification's cache `position` (0 = highest priority).
// Ported verbatim from the original's per-output delay nodes,
// including the fact that position 0 and 1 carry the *same* 1s delay
// before jumping to 3,4,5,6,7,8 for positions 2-7 — an irregularity
// in the source flow (not a clean arithmetic progression) that's
// preserved here rather than "corrected" without confirming it was
// unintentional. Worth asking about before this value ships.
export const CACHE_STAGGER_SECONDS: readonly number[] = [1, 1, 3, 4, 5, 6, 7, 8];

// Only positions 0-7 (8 priority slots) were wired up in the original
// — a 9th+ priority centre in priority-global-cache silently never
// matches, same as here.
const MAX_PRIORITY_POSITIONS = CACHE_STAGGER_SECONDS.length;

// topic is the raw MQTT topic as received — deliberately checked with
// substring matching (not a prefix/startsWith check), matching the
// original's `msg.topic.includes(...)` exactly: a replayed message's
// topic is wrapped as "replay/a/wis2/<grep-centre>/<uuid>/<real-topic>",
// and the substring check is what lets origin/cache classification
// keep working *through* that wrapper without stripping it first (contrast
// with topic-match.ts's stripReplayPrefix, used where an exact-prefix
// check is needed instead, e.g. blacklist/override matching).
export function classifyTopic(topic: string, wnm: Wnm, priorityGlobalCache: readonly string[] | undefined): TopicClassification {
	if (topic.includes('origin/a/wis2')) return { kind: 'origin' };

	if (topic.includes('cache/a/wis2')) {
		if (!priorityGlobalCache || priorityGlobalCache.length === 0) return { kind: 'cache-unprioritized' };

		const globalCache = wnm.properties['global-cache'];
		if (typeof globalCache !== 'string') return { kind: 'ignore' };

		const position = priorityGlobalCache.indexOf(globalCache);
		if (position === -1 || position >= MAX_PRIORITY_POSITIONS) return { kind: 'ignore' };
		return { kind: 'cache', position };
	}

	return { kind: 'ignore' };
}

// Seconds to wait before this classification enters the claim race —
// 0 for anything unstaggered.
export function staggerDelaySeconds(classification: TopicClassification): number {
	return classification.kind === 'cache' ? (CACHE_STAGGER_SECONDS[classification.position] ?? 0) : 0;
}
