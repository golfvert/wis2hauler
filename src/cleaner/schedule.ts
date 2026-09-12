// The Cleaner tab's "Schedule" function node (657fefb1a3a5afae, itself
// a merge of "K/V" + "Schedule delete") -- ported field-for-field.
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
import * as nodePath from 'node:path';

export interface ScheduleConfig {
	/** global.get('rename-to-s3') -- true iff downloader['rename-to'] === 's3'. */
	renameToS3: boolean;
	/** global.get('keep-in-cache') -- config.cleaner['keep-in-cache'], undefined if the cleaner section is absent. */
	keepInCacheSeconds: number | undefined;
	/**
	 * The path-segment marker (e.g. "Downloads/") that identifies a
	 * published link as pointing at a file under downloader['aria-download'],
	 * derived from that same config value by run.ts's
	 * computeDownloadsMarker -- see its doc comment for why a basename
	 * derivation, not the raw directory, is what actually needs to
	 * match. undefined when aria-download isn't configured (a
	 * CLEANER-only deployment that never set it -- see validate.ts's
	 * warning): every record is then skipped rather than guessing a
	 * hardcoded marker, matching the maintainer's "never assume the dir is known".
	 */
	downloadsMarker: string | undefined;
}

export interface ScheduleResult {
	/** ZADD score: Date.now() + keep*1000, as a string (matching the original's String(...)). */
	scoreMs: string;
	/** ZADD member: "<worker>|<path-under-downloads/>". */
	member: string;
}

const CLEANER_REPORTER_PREFIX = 'cleaner-reporter:';

/**
 * Derives ScheduleConfig.downloadsMarker from downloader['aria-download']:
 * the directory's own last path segment, plus a trailing slash -- e.g.
 * "/Users/remy/Docker/WIS2/Aria2/Downloads" -> "Downloads/". This is
 * what actually shows up as a path segment in a published link (see
 * hash.ts's buildLocalHrefAndUri -- only the "no rename" case ever
 * embeds the aria-download path into a link at all, and always as an
 * absolute path containing this directory's own name as a segment),
 * not the raw directory itself, which would never match since a
 * published link never carries a leading "/". Returns undefined when
 * ariaDownloadDir itself is unset (a CLEANER-only deployment that
 * never configured it -- see validate.ts's warning for that case);
 * decideSchedule then skips every record rather than guessing.
 */
export function computeDownloadsMarker(ariaDownloadDir: string | undefined): string | undefined {
	if (!ariaDownloadDir) return undefined;
	const name = nodePath.basename(ariaDownloadDir);
	return name ? `${name}/` : undefined;
}

export function decideSchedule(config: ScheduleConfig, flatPayload: readonly unknown[], channelTopic: string, now: number): ScheduleResult | null {
	// S3 mode: files are uploaded to S3 and not kept on local disk -> nothing to delete.
	if (config.renameToS3) return null;

	const marker = config.downloadsMarker;
	if (!marker) return null; // aria-download not configured -- see ScheduleConfig's doc comment.

	const rec: Record<string, unknown> = {};
	for (let i = 0; i < flatPayload.length; i += 2) {
		rec[String(flatPayload[i])] = flatPayload[i + 1];
	}
	const link = rec.link;

	// Skip records with no local file (download_error / integrity_fail carry no link).
	if (typeof link !== 'string' || link.indexOf(marker) === -1) return null;

	// Retention in seconds; if unset/disabled, keep the file.
	const keep = config.keepInCacheSeconds;
	if (typeof keep !== 'number' || keep <= 0) return null;

	const markerIdx = channelTopic.indexOf(CLEANER_REPORTER_PREFIX);
	const worker = markerIdx === -1 ? channelTopic : channelTopic.substring(markerIdx + CLEANER_REPORTER_PREFIX.length);
	const path = link.substring(link.indexOf(marker) + marker.length);

	return {
		scoreMs: String(now + keep * 1000),
		member: `${worker}|${path}`,
	};
}
