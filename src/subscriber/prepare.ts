// Derives the per-message fields the claim/publish decision (claim.ts)
// and the eventual job-hash record need: which "source" produced this
// copy, and the combined nocache flag (an explicit wnm.properties.cache
// === false OR an overridelist match — see override.ts). Ported from
// the Node-RED "Prepare" change node (Subscriber tab); the three Redis
// key expressions it also built are now redis-keys.ts's job instead
// (downloaderHashKey/downloaderClaimKey/downloaderCompleteKey).
//
// 2026-09-11: briefly changed to override-only (dropping the
// properties.cache === false disjunct entirely) per the maintainer's "Remove
// that" -- reverted the same day once the maintainer pointed out the WIS2 Guide
// requires a Global Cache to still skip downloading AND still
// republish the WNM on cache/... when an origin declares cache:false,
// regardless of what asked for that. That's this exact nocache flag
// (it gates 'download' vs 'publish-only' in claim.ts, and the
// cache-topic republish in consumer.ts's buildPublishOnlyMessages) --
// so removing it here would have skipped the republish and started
// downloading content an origin explicitly said not to cache, which
// is a real WIS2-conformance regression, not just an undoing of the
// unwanted monitor event. What the maintainer actually wants removed is scoped
// narrowly in consumer.ts instead: the monitor-event PUBLISH only,
// not this flag. See consumer.ts's processEntry, 'publish-only' case.
import type { Wnm } from '../wis2/wnm.ts';

export interface PreparedMessage {
	source: string;
	nocache: boolean;
}

// wnmtopic is the message's real topic (NOT stripped of any
// "replay/a/wis2/..." wrapper — the original's `$contains(wnmtopic,"origin")`
// check is a substring test, same "works through the replay wrapper
// without stripping it" reasoning as order-links.ts's classifyTopic).
export function prepareMessage(wnm: Wnm, wnmtopic: string, override: boolean): PreparedMessage {
	let source: string;
	if (wnmtopic.includes('origin')) {
		source = 'origin';
	} else {
		const globalCache = wnm.properties['global-cache'];
		source = typeof globalCache === 'string' ? globalCache.split('-global-cache')[0]! : 'unknown';
	}

	const nocache = wnm.properties.cache === false || override;

	return { source, nocache };
}
