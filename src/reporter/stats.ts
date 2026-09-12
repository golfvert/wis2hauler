// The Reporter tab's "Stats" function node (a3ff30abf87630d1) --
// ported field-for-field. Fed by the "Type ?" switch's else branch
// (anything not integrity_fail/download_error) -- a normal completion
// record. Writes windowed counters into 2-3 Redis hashes (all under
// the SAME hash tag `{windowKey}` so a Cluster keeps them on one
// shard for the multi/pipeline to work), each with a 1h TTL refreshed
// on every write.
//
// Two literal-JS quirks preserved here, not "fixed":
//   - `${windowKey}:combo:${data.centreId}:${data.subtopic}` uses JS
//     template-literal coercion: a null centreId/subtopic renders as
//     the STRING "null" (not empty), so a record with e.g. no
//     recognizable topic still gets its own "null:null" combo bucket
//     rather than being dropped. coerceKeySegment() below reproduces
//     that coercion explicitly (redis-keys.ts's statsComboKey just
//     concatenates whatever string it's given).
//   - the per-source branch is gated on `if (data.source)` -- a
//     falsy (null or empty-string) source skips the src: hash
//     entirely, matching kv.ts's transformKV which already only ever
//     produces null or a non-empty string.
export function coerceKeySegment(value: string | null): string {
	return value === null ? 'null' : value;
}

export interface StatsWriteCommand {
	windowKey: string;
	centreIdSegment: string;
	subtopicSegment: string;
	/** parsed KVRecord.length -- always a number (kv.ts defaults it to 0). */
	length: number;
	/** parsed KVRecord.delay -- passed through as-is (see run.ts's real-store note: a genuinely null delay is defensively written as 0, since HINCRBY requires an integer and the original never exercises this path with delay actually null in practice, per finishing.ts's stored/published fields always being set on a real completion). */
	delay: number | null;
	lastTimestamp: number;
	/** Only set when KVRecord.source is a non-empty string (matches the original's `if (data.source)` gate). */
	source: string | null;
}

export function buildStatsWrite(windowKey: string, record: { centreId: string | null; subtopic: string | null; length: number; delay: number | null; lastTimestamp: number | null; source: string | null }): StatsWriteCommand {
	return {
		windowKey,
		centreIdSegment: coerceKeySegment(record.centreId),
		subtopicSegment: coerceKeySegment(record.subtopic),
		length: record.length,
		delay: record.delay,
		lastTimestamp: record.lastTimestamp ?? 0,
		source: record.source,
	};
}
