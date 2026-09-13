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
// fails it is left alone entirely (log-only in the original, matching
// "link out 10"'s dead end) -- most likely a record already cleaned
// up by a race with another ack.
const FIRST_REGEX = /^\d+-\d+-\d+(-\d+)?$/;

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
 * Returns null when "First ?" rejects the record (no state changed).
 * Otherwise ALWAYS returns the AckedEntry, even when part of the
 * cleanup fan-out below fails -- see the Promise.allSettled comment.
 */
// ackLog: "Ack" (Downloader tab, previous-node 67a08d8a21f14ae1, Debug)
// -- a `catch` node in the original, meaning it only ever logs when
// something in this ack/cleanup fan-out actually throws; it does NOT
// stop the original's separate, parallel wire onward to the
// Complete/WNM-publish chain. Optional and trailing so every existing
// call site keeps compiling without it.
export async function startAck(store: DownloaderStore, queue: string, worker: string, gid: string, ackLog?: SourceLogger): Promise<AckedEntry | null> {
	const flat = await store.getAria2GidRecord(worker, gid);
	const fields = parseFlatRecord(flat);
	const streamId = fields.stream_id;
	if (!streamId || !FIRST_REGEX.test(streamId)) {
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
