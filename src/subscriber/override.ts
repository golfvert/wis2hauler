// The overridelist rules: force "no-cache" (republish only, no
// download) for a notification that matches by topic and/or exceeds
// a declared max size. Ported from the Node-RED "Override" function
// node (Subscriber tab), which must run before the equivalent of
// "Prepare" downstream so its result can OR into the nocache flag.
//
// uuid_cache/uuid_monitor: the original generates these with
// crypto.randomUUID() ONLY inside the branch where a rule actually
// matches (`msg.uuid_cache = msg.override ? uuid_cache : undefined`) —
// they are NOT generated when nocache ends up true for some other
// reason (e.g. wnm.properties.cache === false with no overridelist
// match at all). That matters because the eventual publish-only
// outcome's WNM republish sets its own id to uuid_cache and its
// monitoring event's id to uuid_monitor — so a nocache that came from
// properties.cache alone (no override match) republishes with an
// undefined id, exactly as the original does. Reproduced here
// faithfully rather than "fixed" — flagged in the project notes as a
// pre-existing quirk of the original, not something this port
// introduced.
//
// DELIBERATE DEVIATION, 2026-09-11: `override` (this file's result)
// is ONE of the two conditions consumer.ts's publish-only case checks
// before emitting the WIS2 monitoring event ("Data granule not
// cached") -- the other is that wnm.properties.cache is NOT false
// (true or absent). Both must hold: the monitor event exists to
// report that THIS Global Cache decided not to cache something the
// origin wanted cached -- if the origin already declared
// properties.cache === false itself, there's nothing to report, even
// if an overridelist rule also happens to match. flows.json's own
// "Action ?" rule 1 got this wrong (the maintainer: "My flows.json had a bug
// too" -- it published Monitor whenever nocache was true for ANY
// reason, without rechecking properties.cache first); this is a
// corrected reimplementation of the WIS2 Guide's intended behavior,
// not a faithful port of that rule. The WNM cache-topic republish
// above is NOT gated by any of this -- it still happens for either
// nocache source (cache:false or override), unconditionally, per the
// WIS2 Guide's Global Cache requirements. See consumer.ts's
// processEntry, 'publish-only' case, for the actual condition.
import { matchesTopicPattern, stripReplayPrefix } from '../wis2/topic-match.ts';
import { selectLink, type Wnm } from '../wis2/wnm.ts';
import type { OverrideRule } from '../config/schema.ts';

export interface OverrideResult {
	override: boolean;
	reason?: string;
	uuidCache?: string;
	uuidMonitor?: string;
}

export function evaluateOverride(wnm: Wnm, topic: string, overridelist: readonly OverrideRule[] | undefined): OverrideResult {
	if (!overridelist || overridelist.length === 0) return { override: false };

	const normalisedTopic = stripReplayPrefix(topic);
	const length = selectLink(wnm)?.length;

	for (const rule of overridelist) {
		const hasTopic = rule.topic !== undefined;
		const hasLength = rule['max-length'] !== undefined;
		if (!hasTopic && !hasLength) continue; // ignore empty rules, same as the original

		if (hasTopic && !matchesTopicPattern(normalisedTopic, rule.topic!)) continue;
		if (hasLength && !(typeof length === 'number' && length > rule['max-length']!)) continue; // strictly greater than the ceiling

		const reason = hasTopic
			? `The topic matches a rejected value ( ${rule.topic} ) for this Global Cache`
			: `The file size is larger than ${rule['max-length']} bytes`;
		return { override: true, reason, uuidCache: crypto.randomUUID(), uuidMonitor: crypto.randomUUID() };
	}

	return { override: false };
}
