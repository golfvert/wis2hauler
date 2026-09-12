// MQTT wildcard topic matching, and the "replay/a/wis2/..." prefix
// normalisation applied before matching a replayed message's topic
// against blacklist/overridelist rules. Ported from the Node-RED
// Subscriber tab, where this exact algorithm appeared independently
// three times: twice in near-duplicate "Black & GRep" function nodes
// (blacklist filtering) and once, renamed to `topicMatch`, inside the
// "Override" function node — same MQTT +/# wildcard semantics all
// three times. Centralized here per the dedupe principle from the
// project's architecture notes (C.1) — the same principle that
// decided to merge the two Black & GRep copies extends naturally to
// this third, functionally-identical copy found while porting
// Subscriber, and to the "strip the replay/a/wis2/... prefix before
// matching" step, which was *also* duplicated in all three call sites.

// Matches topic against an MQTT wildcard pattern: '+' matches exactly
// one level, '#' matches that level and everything after it (only
// valid as the pattern's final level — same restriction as a real
// MQTT broker; this function doesn't itself validate pattern shape,
// see topics.ts's isValidMqttTopic/isValidTopicPattern for that).
export function matchesTopicPattern(topic: string, pattern: string): boolean {
	const topicParts = topic.split('/');
	const patternParts = pattern.split('/');

	for (let i = 0; i < patternParts.length; i++) {
		const patternPart = patternParts[i];
		if (patternPart === '#') return true;
		const topicPart = topicParts[i];
		if (topicPart === undefined) return false;
		if (patternPart === '+') continue;
		if (patternPart !== topicPart) return false;
	}
	return topicParts.length === patternParts.length;
}

// A replayed message's real topic is wrapped as
// "replay/a/wis2/<grep-centre-id>/<uuid>/<real-topic...>" — this
// strips that wrapper (levels 0-4) so blacklist/overridelist rules,
// which are written against the real topic, still apply to replayed
// messages the same way they apply to live ones.
export function stripReplayPrefix(topic: string): string {
	if (!topic.startsWith('replay/a/wis2/')) return topic;
	return topic.split('/').slice(5).join('/');
}

// True if topic (already replay-stripped by the caller — see
// stripReplayPrefix) matches any pattern in blacklist.
export function isBlacklisted(topic: string, blacklist: readonly string[]): boolean {
	return blacklist.some((pattern) => matchesTopicPattern(topic, pattern));
}
