// Port of the "StartAck" subflow (link-in bed6957b5bd71319): the
// common ack/cleanup routine every completed-or-cancelled download
// runs through, regardless of which of its 4 call sites triggered it
// (a real aria2 onDownloadComplete, a real aria2 onDownloadError, the
// embedded-content fast path's own synthetic gid, or a Cleaner-issued
// cancel command). All 4 set msg.topic = [aria2GidKey(worker, gid)]
// before invoking this, matching store.getAria2GidRecord()'s contract.
import { parseFlatRecord } from './kv.ts';
import type { DownloaderStore } from './store.ts';
import type { SourceLogger } from '../logging/logger.ts';

// "First ?" (853bf782c01c5496): a regex-shaped existence/sanity check
// on the fetched record's stream_id, NOT a real-vs-synthetic
// aria2 distinguisher -- both a real aria2 stream_id (millis-epoch
// "-" random) and Decode & Write's synthetic gid
// ("<entry-id>-<random>", where entry-id is itself a Redis Stream ID
// shaped "<millis>-<seq>") satisfy this same pattern. A record that
// still fails it after retrying (see RETRY_DELAYS_MS below) is left
// alone entirely (log-only in the original, matching "link out 10"'s
// dead end) -- most likely a record already cleaned up by a race with
// another ack.
const FIRST_REGEX = /^\d+-\d+-\d+(-\d+)?$/;

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// NOT a port -- added 2026-09-13 after a live investigation (log
// correlation across SUBSCRIBER/DOWNLOADER workers, no Redis query
// needed -- see the project's own runbook notes) traced a batch of
// small, fast-completing downloads (Environment Canada citypage_weather
// XML bulletins, ~550-650ms end-to-end) that vanished with NO trace
// anywhere -- no completion, no retry, no hash-error, no exception on
// this worker's own stdout -- to a genuine race in aria-start.ts's
// startRealDownload: once aria2.addUri() resolves with a gid, this
// module's "First ?" check (getAria2GidRecord, right below) depends on
// aria-start.ts having already promoted the pre-registered
// stream-id-keyed record to the gid-keyed key read here
// (getStreamEntry -> setAria2GidFields, two more sequential Redis
// round trips AFTER addUri() already returned). A download fast enough
// for its own onDownloadComplete notification to reach this function
// before that promotion finishes finds nothing here yet -- and looks
// indistinguishable from a genuinely-already-cleaned-up record, so it
// silently vanished, with nothing to retry it. These two delays are a
// generous multiple of that race window (2 ordinary Redis round trips,
// expected in the single-digit milliseconds even under load): up to
// 400ms of added latency, paid only when this specific race actually
// happens, buys real headroom against Redis-cluster contention during
// a same-millisecond download burst (the citypage_weather case was 16
// downloads landing within 20ms of each other on one worker).
const RETRY_DELAYS_MS = [100, 300];

export interface AckedEntry {
	streamId: string;
	downloaderId: string;
	/** The work-queue stream entry id XACK/XDEL was attempted against -- msg.payload.download_entry_id in the original. '' for a retry (see aria-start.ts's AriaStartEntry.workQueueEntryId), which skips those two calls entirely. */
	downloadEntryId: string;
	href: string;
	filename: string;
}

/**
 * Fetches the aria2_gid record, checks it looks like a real registration,
 * and if so runs the "Ack"/"Del"/"Clean"x3 fan-out (XACK + XDEL the
 * work-queue entry, DEL the stream_id / stream_id:expire / aria2_gid
 * keys). The 3 DELs are independent of each other and of the XACK/XDEL
 * pair in the original (all fanned from parallel wires off one change
 * node) -- fired concurrently here rather than replicating the
 * original's incidental sequential wiring of the 3 Clean->DEL steps.
 *
 * Returns null when "First ?" still rejects the record after retrying
 * (see RETRY_DELAYS_MS) -- no state changed. Otherwise ALWAYS returns
 * the AckedEntry, even when part of the cleanup fan-out below fails --
 * see the Promise.allSettled comment.
 */
// ackLog: "Ack" (Downloader tab, previous-node 67a08d8a21f14ae1, Debug)
// -- a `catch` node in the original, meaning it only ever logs when
// something in this ack/cleanup fan-out actually throws; it does NOT
// stop the original's separate, parallel wire onward to the
// Complete/WNM-publish chain. Optional and trailing so every existing
// call site keeps compiling without it. The final give-up warn below
// (after retries are exhausted) is NOT a port -- see RETRY_DELAYS_MS's
// own comment -- so it's leveled per the maintainer's own info/warn/
// debug policy rather than any flows.json precedent: WARN, since a
// download the rest of the pipeline will never learn finished is
// "something not good in itself", not routine per-message detail.
export async function startAck(
	store: DownloaderStore,
	queue: string,
	worker: string,
	gid: string,
	ackLog?: SourceLogger,
	sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<AckedEntry | null> {
	let flat = await store.getAria2GidRecord(worker, gid);
	let fields = parseFlatRecord(flat);
	let streamId = fields.stream_id;

	let attempt = 0;
	while ((!streamId || !FIRST_REGEX.test(streamId)) && attempt < RETRY_DELAYS_MS.length) {
		await sleep(RETRY_DELAYS_MS[attempt]!);
		attempt++;
		flat = await store.getAria2GidRecord(worker, gid);
		fields = parseFlatRecord(flat);
		streamId = fields.stream_id;
	}

	if (!streamId || !FIRST_REGEX.test(streamId)) {
		ackLog?.warn({ worker, gid, retries: attempt, reason: 'no aria2_gid record found after retrying (First ? check)' });
		return null;
	}

	const downloadEntryId = fields.download_entry_id ?? '';

	// Promise.allSettled, not Promise.all: matches the original's 5
	// independent redis-command nodes, each with its OWN Catch node
	// (Debug-only, never halting), so one failing here can never
	// propagate out of startAck() and abort the caller's downstream
	// runCompletion(). Found 2026-09-13: a literal Promise.all was
	// silently dropping EVERY retried download's whole completion (hash
	// verify + WNM publish) in production, because a retry's
	// download_entry_id is always '' (see below) and ackWorkQueueEntry
	// ('') used to throw "ERR Invalid stream ID specified as stream
	// command argument", which this function then rethrew straight
	// through handleAriaNotification, uncaught, before runCompletion()
	// was ever reached.
	//
	// downloadEntryId === '' means this is a retried attempt
	// (aria-start.ts's AriaStartEntry.workQueueEntryId was left unset):
	// there is no real work-queue entry left to ack -- error-retry.ts's
	// runRetryDecision() already XACK'd/XDEL'd the ORIGINAL entry back
	// when this download first failed -- so skip these two calls
	// entirely rather than issuing a guaranteed-to-fail XACK/XDEL
	// against a synthetic id that was never enqueued.
	const results = await Promise.allSettled([
		downloadEntryId === '' ? Promise.resolve() : store.ackWorkQueueEntry(queue, downloadEntryId),
		downloadEntryId === '' ? Promise.resolve() : store.deleteWorkQueueEntry(queue, downloadEntryId),
		store.deleteStreamEntry(worker, streamId),
		store.deleteStreamEntryExpire(worker, streamId),
		store.deleteAria2GidRecord(worker, gid),
	]);
	for (const result of results) {
		if (result.status === 'rejected') {
			ackLog?.debug({ worker, gid, streamId, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
		}
	}

	return {
		streamId,
		downloaderId: fields.downloader_id ?? '',
		downloadEntryId,
		href: fields.href ?? '',
		filename: fields.filename ?? '',
	};
}
