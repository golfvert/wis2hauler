// The Cleaner tab's "Process Errors" function node (83e1371b32e9608f)
// -- ported field-for-field. Fed by "Poll Errors" (86db091ec0bc5107,
// 5s repeat) -> "Cleaner ?" gate (bc606cd68ed70ca1: cleaner-primary &&
// run-mode) -> "Read" (d0c8b0be856355d3, builds the XREAD args off
// global.lastErrorId) -> "XREAD" (f8db455e64558271) -> "Read ?"
// (1268ac50f3832247: payload not null). All of that is orchestration
// (see run.ts); this file is the pure reshape + lastErrorId advance.
//
// XREAD's reply shape (ioredis, block:false): payload is either null
// (nothing new -- "Read ?" gates this out before reaching here) or
// [[streamName, [[entryId, [field, value, ...]], ...]]]. The original
// only ever reads msg.payload[0] -- a single stream was requested, so
// only one is ever returned.
//
// Each entry's `error` field is JSON.parse'd back into an object/array
// when possible (it was $string()-stringified by whatever wrote it);
// on parse failure the raw string is kept as-is, matching the
// original's try/catch. Every processed entry is just handed to a
// debug link-out in the original (411f08083f4fc6c6) -- there's no
// further consumer traced in flows.json's Cleaner tab -- so this
// module's job ends at "drain the error stream and advance
// lastErrorId"; run.ts is free to log the parsed messages.
export interface ParsedErrorMessage {
	topic: string;
	payload: unknown;
	timestamp: string | undefined;
	entryId: string;
}

export interface ProcessErrorsResult {
	messages: ParsedErrorMessage[];
	/** The new value to store as global.lastErrorId, or null if there were no entries (leave it unchanged). */
	lastErrorId: string | null;
}

/** Raw XREAD reply shape this function expects: [[streamName, [[entryId, flatFields], ...]]]. */
export type XreadReply = [string, [string, string[]][]][];

export function processErrors(payload: XreadReply): ProcessErrorsResult {
	const [streamEntry] = payload;
	if (!streamEntry) return { messages: [], lastErrorId: null };
	const [streamName, entries] = streamEntry;

	const messages: ParsedErrorMessage[] = [];
	for (const [entryId, fields] of entries) {
		const obj: Record<string, string> = {};
		for (let i = 0; i < fields.length; i += 2) {
			obj[fields[i]!] = fields[i + 1]!;
		}

		let errorData: unknown;
		try {
			errorData = JSON.parse(obj.error ?? '');
		} catch {
			errorData = obj.error;
		}

		messages.push({ topic: streamName, payload: errorData, timestamp: obj.timestamp, entryId });
	}

	const lastEntry = entries[entries.length - 1];
	const lastErrorId = lastEntry ? lastEntry[0] : null;

	return { messages, lastErrorId };
}
