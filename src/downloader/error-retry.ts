// Port of the "Bad Hash" (41c60a819985992f) and "Error"
// (febdd299270156ec) link-in chains: reached on HASH_NOK from
// complete.ts, or on a real aria2 onDownloadError notification /
// Cleaner-issued cancel (via ack.ts's startAck() succeeding on the
// Error branch). Both immediately (and unconditionally, independent of
// whatever the retry decision below concludes) publish a
// cleaner-reporter notification, and both feed the SAME 30s delay
// before the shared retry decision (decideRetry, retry.ts) runs.
import { decideRetry } from './retry.ts';
import { parseFlatRecord } from './kv.ts';
import { startRealDownload, type AriaStartDeps } from './aria-start.ts';
import type { DownloaderStore } from './store.ts';
import type { SourceLogger } from '../logging/logger.ts';

export interface ErrorRetryDeps {
	store: DownloaderStore;
	queue: string;
	worker: string;
	ariaStart: AriaStartDeps;
	sleep: (ms: number) => Promise<void>;
	/** `${Date.now()}-99-${randomSixDigits}` -- the synthetic re-queue entry id ("Re-queue", 835bcad5013f7c05); injectable for deterministic tests. */
	mintRequeueId: () => string;
	// "Re-queue" (previous-node 107baa40af9e88b4, Warn) and "Update"
	// (previous-node c4847bd8123fe67d, Warn) -- the two change nodes
	// RETRY_OK fans out to below. Optional so every existing hand-built
	// ErrorRetryDeps in this file's own tests keeps compiling without them.
	requeueLog?: SourceLogger;
	updateLog?: SourceLogger;
}

// "Bad hash" (e84fcaddef70ece8): PUBLISH cleanerReporterKey(worker)
// ["type","integrity_fail","topic",wnmTopic].
export async function reportBadHash(deps: ErrorRetryDeps, wnmTopic: string): Promise<void> {
	await deps.store.publishCleanerReport(deps.worker, JSON.stringify(['type', 'integrity_fail', 'topic', wnmTopic]));
}

// "Error" (fe79eca7c30f4be3): PUBLISH cleanerReporterKey(worker)
// ["type","download_error","topic", wnmTopic or "" if unknown --
// e.g. a Cleaner-issued cancel never populated wnmtopic on msg in the
// original, matching $exists(wnmtopic) ? wnmtopic : ""].
export async function reportDownloadError(deps: ErrorRetryDeps, wnmTopic: string | undefined): Promise<void> {
	await deps.store.publishCleanerReport(deps.worker, JSON.stringify(['type', 'download_error', 'topic', wnmTopic ?? '']));
}

/**
 * The 30s-delayed retry decision ("30s" delay node, e017d6ebcfd5b26d ->
 * "Extract"/"HGET" -> HGETALL -> "Next" [retry.ts's decideRetry] ->
 * "Retry ?"). RETRY_OK promotes the first waiting href and starts a
 * real aria2 download for it (never the embedded-content fast path --
 * see aria-start.ts's header comment); RETRY_NOK records the exhausted
 * job on the error stream; RETRY_NONEED is a silent no-op, matching
 * the original's empty third wire.
 */
export async function runRetryDecision(deps: ErrorRetryDeps, downloaderId: string): Promise<void> {
	await deps.sleep(30000);

	const flat = await deps.store.getDownloaderRecord(downloaderId);
	const decision = decideRetry(flat);

	// NOT a port -- added 2026-09-13 after a live investigation (the
	// maintainer: "Pretty useless logs") found the original's bare
	// `$string(payload)` -- just the flat hash array, verbatim -- gave
	// no way to tell which download a RETRY_NOK entry was even for: the
	// downloader_id lives only in the Redis KEY name (downloaderHashKey),
	// never as a hash field, so it was never present in what got
	// recorded here. Worse, `flat` itself can legitimately be `[]` (the
	// hash already gone by this 30s-later HGETALL -- e.g. its 7200s TTL
	// finally lapsed on a message that sat in a backlog that long), which
	// looked identical to "genuinely nothing worth retrying" in the raw
	// array with no way to tell the two apart. Wrapping the same array
	// (unchanged, still `decision.payload`) with the downloaderId this
	// function already has in scope, plus an explicit hashFound flag,
	// costs nothing structurally but makes every RETRY_NOK entry
	// correlatable (grep the downloader_id straight out of the log) and
	// makes the "hash already vanished" case distinguishable from "hash
	// present, no fallback href available" at a glance.

	if (decision.retry === 'RETRY_OK') {
		const fields = parseFlatRecord(flat);
		await deps.sleep((decision.delaySeconds ?? 0) * 1000);
		deps.requeueLog?.warn({ downloaderId, href: decision.extracted ?? '', topic: fields.topic ?? '' });
		deps.updateLog?.warn({ downloaderId, promoteHref: decision.promoteHref, newAttempt: decision.newAttempt });
		await Promise.all([
			// workQueueEntryId deliberately omitted: the original
			// work-queue entry was already XACK'd/XDEL'd by the startAck()
			// call that routed this download into the retry pipeline in
			// the first place, and mintRequeueId()'s synthetic id was
			// never itself a real work-queue entry -- see aria-start.ts's
			// AriaStartEntry.workQueueEntryId doc for the bug this avoids.
			startRealDownload(deps.ariaStart, {
				id: deps.mintRequeueId(),
				downloaderId,
				href: decision.extracted ?? '',
				topic: fields.topic ?? '',
			}),
			deps.store.retryTransition(downloaderId, decision.promoteHref, decision.promoteSource, decision.newAttempt, decision.errorHref, decision.errorSource),
		]);
	} else if (decision.retry === 'RETRY_NOK') {
		await deps.store.recordError(
			deps.queue,
			deps.worker,
			JSON.stringify({ downloaderId, hashFound: flat.length > 0, hash: decision.payload }),
		);
	}
	// RETRY_NONEED: no-op -- matches the "Retry ?" switch's empty 3rd wire.
}
