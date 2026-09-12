// WIS2 topic grammar and small string-validation helpers shared across
// the static-config validator (validate.ts) and the live runtime-patch
// validator (runtime.ts). Ported 1:1 from the Node-RED "Validate" and
// "Updates" function nodes in the Setup tab of flows.json, which both
// duplicated this exact logic independently — centralized here per the
// "dedupe" decision (see the project's architecture notes, C.1).
//
// A WIS2 notification-message topic has a fixed 6-level shape:
//   <origin|cache|monitor|+> / a / wis2 / <centre-id> / <data|metadata|+> / <...>
// where level 4 (centre-id) must contain at least one hyphen, and any
// non-wildcard segment is lowercase alphanumeric-with-hyphens. '#' is
// only valid as the final level (standard MQTT semantics).

export function isValidMqttTopic(topic: unknown): string | null {
	if (typeof topic !== 'string' || topic.length === 0) return 'empty or not a string';
	const parts = topic.split('/');
	const isValidSegment = (s: string) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i]!;
		const isLast = i === parts.length - 1;

		if (part === '#') {
			if (!isLast) return `'#' at level ${i + 1} must be the last level`;
			continue;
		}

		switch (i) {
			case 0:
				if (!['origin', 'cache', 'monitor', '+'].includes(part))
					return `level 1 must be 'origin', 'cache', 'monitor' or '+' (got '${part}')`;
				break;
			case 1:
				if (part !== 'a')
					return `level 2 must be 'a' (got '${part}')${part === '+' ? ' — + not allowed here' : ''}`;
				break;
			case 2:
				if (part !== 'wis2')
					return `level 3 must be 'wis2' (got '${part}')${part === '+' ? ' — + not allowed here' : ''}`;
				break;
			case 3:
				if (part === '+') break;
				if (!isValidSegment(part) || !part.includes('-'))
					return `level 4 must contain at least one '-' and be alphanumeric-hyphen (got '${part}')`;
				break;
			case 4:
				if (!['data', 'metadata', '+'].includes(part))
					return `level 5 must be 'data', 'metadata' or '+' (got '${part}')`;
				break;
			default:
				if (part === '+') break;
				if (!isValidSegment(part)) {
					return isLast
						? `last level must be lowercase alphanumeric with optional hyphens (got '${part}')`
						: `level ${i + 1} '${part}' is invalid — use lowercase alphanumeric with optional hyphens only`;
				}
		}
	}
	return null;
}

// A credentials-map key (downloader.credentials in the static config,
// and the "credentials" runtime-patch op) must be a *concrete* WIS2
// topic identifying one data source's "recommended" download link:
// origin/a/wis2/<centre-id>/recommended/<...> — level 1 is fixed to
// 'origin' (not 'cache'/'monitor'/'+') and level 5 is fixed to
// 'recommended' (not 'data'/'metadata'/'+'), since credentials are
// scoped to a specific producer's recommended-link downloads, not a
// topic pattern.
export function isValidCredentialTopic(topic: unknown): string | null {
	if (typeof topic !== 'string' || topic.trim().length === 0) return 'missing or empty';
	const err = isValidMqttTopic(topic);
	if (err) return err;
	const parts = topic.split('/');
	if (parts[0] !== 'origin') return `must start with 'origin' (got '${parts[0]}')`;
	if (parts[5] !== 'recommended') return `must have 'recommended' at level 6 (got '${parts[5] ?? 'undefined'}')`;
	return null;
}

// The plain string-pattern check used for blacklist/overridelist
// entries, which — unlike whitelist entries — are matched as literal
// wildcard patterns rather than validated against the strict 6-level
// WIS2 grammar above (a blacklist entry may legitimately be a partial
// pattern like '+/+/+/+/+/recommended/#').
const TOPIC_PATTERN_CHARS = /^[a-zA-Z0-9\-/+#]+$/;
export function isValidTopicPattern(topic: unknown): boolean {
	return typeof topic === 'string' && TOPIC_PATTERN_CHARS.test(topic);
}
