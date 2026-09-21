// One entry per SourceLogger name Hauler's own codebase binds via
// createSourceLogger(name, ...) (../src/logging/logger.ts from here, now
// that this tool lives inside the wis2hauler repo as Tracer/) -- kept in
// sync BY HAND with ../src/*/run.ts and ../src/main.ts's call sites
// rather than imported. Deliberate, not an oversight: this tool
// `bun build --compile`s to a standalone binary of its own (see
// ../.github/workflows/release.yml), independent of wis2hauler's own
// release cadence and with none of its runtime dependencies (winston,
// ioredis, mqtt, ...) -- importing straight from ../src would pull all
// of that into a supposedly-standalone log-reading tool. The KEY
// here is the slug createSourceLogger actually writes to disk with
// (src/logging/slug.ts's slugifySource: lowercase, strip everything but
// a-z), which is what shows up in each log file's name --
// wis2gc-<slug>-<date-hour>.<level>.log[.gz] (src/logging/sink.ts).
//
// This map only drives the human-readable narrative (name/role/stage) --
// it never gates matching. A slug missing from here still gets
// traced and printed, just with a generic "(unrecognized source)"
// label, so a future Hauler logger this file hasn't been updated for
// doesn't silently vanish from a trace.
export interface SourceMeta {
	/** The original, unslugified SourceLogger name, e.g. "Correct ?". */
	name: string;
	role: 'SUBSCRIBER' | 'DOWNLOADER' | 'CLEANER' | 'SETUP' | '?';
	/** One line: what this log line means when you see it in a trace. */
	stage: string;
}

const UNKNOWN: SourceMeta = { name: '(unknown)', role: '?', stage: '(unrecognized source -- update src/sources.ts if this is a real Hauler logger)' };

export const SOURCE_META: Record<string, SourceMeta> = {
	// SUBSCRIBER (src/subscriber/run.ts, src/subscriber/ingest.ts, src/subscriber/consumer.ts)
	received: {
		name: 'Received',
		role: 'SUBSCRIBER',
		stage: 'message arrived on the wire (pre-parse, before rbe/blacklist/dedup) -- ground truth for "did this arrive at all"',
	},
	filter: {
		name: 'Filter',
		role: 'SUBSCRIBER',
		stage: 'per-message ingest outcome: unchanged (rbe) / blacklisted / malformed / duplicate (wnm.id) / ingested -- carries the full parsed WNM',
	},
	decision: {
		name: 'Decision',
		role: 'SUBSCRIBER',
		stage: 'per-notification decision: ignore / already-complete / download / wait / drop / publish-only',
	},
	duplicate: {
		name: 'Duplicate',
		role: 'SUBSCRIBER',
		stage: 'data_id reused without rel=update -- lineage dedup caught it before it ever reached DOWNLOADER',
	},

	// DOWNLOADER (src/downloader/run.ts and the files it wires into ConsumerDeps)
	aria: { name: 'Aria', role: 'DOWNLOADER', stage: 'a real aria2 download was registered (addUri)' },
	ack: { name: 'Ack', role: 'DOWNLOADER', stage: 'a download was acknowledged/promoted after aria2 reported completion' },
	outputcomplete: { name: 'Output - Complete', role: 'DOWNLOADER', stage: "aria2's own onDownloadComplete notification" },
	outputerror: { name: 'Output - Error', role: 'DOWNLOADER', stage: "aria2's own onDownloadError notification (now carries aria2's errorCode/errorMessage)" },
	correct: { name: 'Correct ?', role: 'DOWNLOADER', stage: 'hash validation anomaly at complete time (hashOutcome/hashDetail: digest-mismatch vs unsupported-method)' },
	requeue: { name: 'Re-queue', role: 'DOWNLOADER', stage: 'a failed attempt was requeued for retry' },
	update: { name: 'Update', role: 'DOWNLOADER', stage: 'a retry was promoted to a new real download attempt' },
	duplicates: { name: 'Duplicates', role: 'DOWNLOADER', stage: 'evicted as a duplicate file write at complete time' },
	pollerror: { name: 'Poll Error', role: 'DOWNLOADER', stage: 'poll-loop error before/around aria2 (aria2 unreachable, addUri rejected, etc.)' },

	// Shared between SUBSCRIBER and DOWNLOADER -- disambiguate with the
	// line's own `role` field (both write to the same wis2gc-publish-*
	// file on purpose, see finishing.ts's/consumer.ts's own doc comments).
	publish: { name: 'Publish', role: '?', stage: 'republished to a cache/monitor topic -- check this line\'s own "role" field for SUBSCRIBER vs DOWNLOADER' },

	// CLEANER (src/cleaner/run.ts)
	processerrors: { name: 'Process Errors', role: 'CLEANER', stage: 'an entry from the error stream was processed by CLEANER' },
	cleanredis: { name: 'Clean Redis', role: 'CLEANER', stage: 'a CLEANER sweep summary (not per-message; rarely worth matching on an id)' },

	// SETUP / startup (src/main.ts) -- essentially never carry a data_id/
	// wnm.id, included only so an accidental match isn't unexplained.
	invalid: { name: 'Invalid', role: 'SETUP', stage: 'config validation failed at startup' },
	valid: { name: 'Valid', role: 'SETUP', stage: 'config validated at startup' },
	config: { name: 'Config', role: 'SETUP', stage: 'startup config summary' },
	change: { name: 'Change ?', role: 'SETUP', stage: 'a live POST /set runtime config change' },
};

export function describeSource(slug: string): SourceMeta {
	return SOURCE_META[slug] ?? UNKNOWN;
}
