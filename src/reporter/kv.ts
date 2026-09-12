// The Reporter tab's "K/V" function node (5eda3a133db03150) -- ported
// field-for-field. Fed by the "Reporter" redis-in psubscribe node
// (4dda7432857f6b17, pattern "wis2gc:cleaner-reporter:*") through the
// "Reporter ?" gate (a94892868ef6cf36: reporter-primary && config_valid
// && run-mode), which is orchestration (see run.ts), not this pure
// transform.
//
// Reshapes the flat [field, value, ...] cache-reporter record (the
// SAME record Cleaner's schedule.ts consumes -- see finishing.ts's
// report / error-retry.ts's reportBadHash/reportDownloadError for what
// producers actually publish) into an object, then derives 5 extra
// fields the rest of the Reporter tab consumes: length, delay,
// centreId, subtopic, source, lastTimestamp.
export interface KVRecord {
	/** Every raw field from the flat record, string-keyed (values NOT reparsed beyond what the original does). */
	raw: Record<string, unknown>;
	/** parseInt(raw.length) if present, else 0 -- matches the original's `output.length ? parseInt(output.length) : 0` (a raw.length of "0" is falsy as a string... no, "0" is truthy as a non-empty string; only an EMPTY string or missing field is falsy here). */
	length: number;
	/** parseInt(raw.stored) - Date(raw.published).getTime(), or null if either is missing. */
	delay: number | null;
	/** raw.topic's 4th "/"-separated segment (index 3), or null if topic is missing or has fewer than 4 segments. */
	centreId: string | null;
	/** raw.topic's segments 6-8 (index 5..7 inclusive), joined by "/", or null if topic is missing or has fewer than 6 segments. */
	subtopic: string | null;
	/** raw[`src:${k}`] for whichever raw field's value is a string starting with "complete" (the FIRST such field found in object-key iteration order), or null if none found or that sibling field is missing/falsy. */
	source: string | null;
	/** Math.floor(parseInt(raw.stored) / 1000), or null if raw.stored is missing. */
	lastTimestamp: number | null;
}

export function transformKV(flatPayload: readonly unknown[]): KVRecord {
	const raw: Record<string, unknown> = {};
	for (let i = 0; i < flatPayload.length; i += 2) {
		raw[String(flatPayload[i])] = flatPayload[i + 1];
	}

	const length = raw.length ? parseInt(String(raw.length), 10) : 0;

	let delay: number | null = null;
	if (raw.stored && raw.published) {
		delay = parseInt(String(raw.stored), 10) - new Date(String(raw.published)).getTime();
	}

	let centreId: string | null = null;
	let subtopic: string | null = null;
	if (typeof raw.topic === 'string') {
		const parts = raw.topic.split('/');
		if (parts.length >= 4) centreId = parts[3]!;
		if (parts.length >= 6) subtopic = parts.slice(5, 8).join('/');
	}

	let source: string | null = null;
	for (const [k, v] of Object.entries(raw)) {
		if (typeof v === 'string' && v.startsWith('complete')) {
			const sibling = raw[`src:${k}`];
			source = typeof sibling === 'string' && sibling ? sibling : null;
			break;
		}
	}

	const lastTimestamp = raw.stored ? Math.floor(parseInt(String(raw.stored), 10) / 1000) : null;

	return { raw, length, delay, centreId, subtopic, source, lastTimestamp };
}
