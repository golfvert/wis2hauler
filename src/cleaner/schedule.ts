// The Cleaner tab's "Schedule" function node (657fefb1a3a5afae, itself
// a merge of "K/V" + "Schedule delete") -- ported field-for-field,
// with one deliberate deviation from the original documented below.
// Fed by the "Cleaner" redis-in psubscribe node (a8a76a5fc30cc193,
// pattern "wis2gc:cleaner-reporter:*") through the "Cleaner ?" gate
// (d1a37dc7eb2804ea: cleaner-primary && cleaning-needed && run-mode),
// which is orchestration (see run.ts), not this pure decision.
//
// In: the flat [field, value, ...] cache-reporter record published on
// channel "wis2gc:cleaner-reporter:<worker>", plus that channel name
// as the pubsub "topic". Out: the ZADD wis2gc:cleaner:pending
// <deleteAtMs> <worker>|<path> to run, or null to skip -- verbatim
// behavior including the pre-existing quirk (kept, not "fixed" per
// "NO GUESS"): if keep-in-cache is <= 0 this returns null (skip, file
// kept forever), even though validate.ts's warning message for that
// same value says "files will be deleted immediately" -- the original
// Schedule function's own `typeof keep !== 'number' || keep <= 0` guard
// contradicts that warning text; ported exactly as coded.
//
// CORRECTED AGAIN, 2026-09-13 (the maintainer): the 2026-09-13 fix earlier
// today made this match flows.json's real Schedule node exactly --
// hardcoding the literal `'downloads/'` (`link.indexOf('downloads/')` /
// `link.substring(...)`) instead of the file's original, wronger
// `downloader['aria-download']`-derived marker. That flows.json-faithful
// hardcoded literal is ITSELF still wrong for this port, though, for a
// reason that never applied to the original: the original ONLY ever ran
// inside Docker, where every worker's aria-download was, by convention,
// always some path containing "/downloads" -- guaranteed by how the
// images were built, not by anything in the flow logic. This port also
// supports bare-metal deployment, where an operator can point
// downloader['aria-download'] at any directory name at all (see this
// worker's own run.ts) -- the fleet no longer has ANY string every
// worker's local path is guaranteed to contain, so hardcoding
// "downloads/" silently and permanently stops scheduling eviction for
// any worker whose directory doesn't happen to contain that literal.
//
// Fix (the maintainer's "option 1, with the caveat for S3, and it must
// work for docker and bare metal"): stop trying to re-derive the local
// path by pattern-matching the published "link" URL at all. Each
// DOWNLOADER worker already knows -- authoritatively, from its own
// hash.ts -- the exact path it wrote the file to, relative to its OWN
// aria-download; that value now rides along on the SAME cleaner-reporter
// record as a new "local-path" field (see lua.ts's LUA_COMPLETE and
// finishing.ts), so CLEANER just reads it back verbatim instead of
// guessing. This works identically under Docker (where "local-path"
// happens to still look like the old marker-relative fragment) and bare
// metal (where it doesn't need to). It also subsumes the old
// `renameToS3` field: S3-mode downloads are uploaded then immediately
// deleted locally (hash.ts's S3 branch), so hash.ts never produces a
// localPath for them, "local-path" comes back empty, and this decision
// already skips exactly that case with no separate S3 flag needed.
// Records published by a not-yet-upgraded worker (rolling deploy) simply
// have no "local-path" field at all -- treated the same as empty:
// skipped, not deleted blind.

export interface ScheduleConfig {
	/** global.get('keep-in-cache') -- config.cleaner['keep-in-cache'], undefined if the cleaner section is absent. */
	keepInCacheSeconds: number | undefined;
}

export interface ScheduleResult {
	/** ZADD score: Date.now() + keep*1000, as a string (matching the original's String(...)). */
	scoreMs: string;
	/** ZADD member: "<worker>|<local-path>". */
	member: string;
}

const CLEANER_REPORTER_PREFIX = 'cleaner-reporter:';

export function decideSchedule(config: ScheduleConfig, flatPayload: readonly unknown[], channelTopic: string, now: number): ScheduleResult | null {
	const rec: Record<string, unknown> = {};
	for (let i = 0; i < flatPayload.length; i += 2) {
		rec[String(flatPayload[i])] = flatPayload[i + 1];
	}
	const localPath = rec['local-path'];

	// Skip records with no locally-cached file: S3-mode downloads (hash.ts
	// never sets local-path for them), download_error/integrity_fail
	// records (no link, no local-path), and records from a worker that
	// hasn't yet been upgraded to publish "local-path" at all.
	if (typeof localPath !== 'string' || localPath === '') return null;

	// Retention in seconds; if unset/disabled, keep the file.
	const keep = config.keepInCacheSeconds;
	if (typeof keep !== 'number' || keep <= 0) return null;

	const markerIdx = channelTopic.indexOf(CLEANER_REPORTER_PREFIX);
	const worker = markerIdx === -1 ? channelTopic : channelTopic.substring(markerIdx + CLEANER_REPORTER_PREFIX.length);

	return {
		scoreMs: String(now + keep * 1000),
		member: `${worker}|${localPath}`,
	};
}
