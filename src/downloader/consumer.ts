// The Downloader main loop: the "Init" inject (7313f19a0561886b,
// repeats every 2s) -> "Ready ?" -> XINFO/"Values"/"Length ?" gate ->
// "Queue"/XREADGROUP -> "Href" reshape -> per-entry "Content ?" fan-out
// (decode-write.ts's embedded-content fast path, or aria-start.ts's
// real aria2 download) -- PLUS the asynchronous side of the pipeline:
// aria2's pushed onDownloadComplete/onDownloadError notifications
// ("Back" switch's first two branches, ported into aria2.ts's
// onNotification callback), each of which calls tellStatus, checks the
// result shape ("Output - Complete"/"Output - Error"), runs
// ack.ts's startAck(), and routes into complete.ts/finishing.ts (on a
// real completion) or error-retry.ts (on a real error).
//
// NOT ported: the "Ready ?" switch's own global downloader/redis_ready/
// config_valid/process-mode gate -- this loop starts only once run.ts
// has already connected everything it needs, which is what that gate
// existed to wait for; Subscriber's consumer.ts has the same
// unstated precedent (its own runConsumerLoop starts unconditionally
// too).
import { startAck } from './ack.ts';
import { runComplete, type CompleteDeps } from './complete.ts';
import { runDecodeWrite, type DecodeWriteIO } from './decode-write.ts';
import { reportBadHash, reportDownloadError, runRetryDecision, type ErrorRetryDeps } from './error-retry.ts';
import { runFinishing, type FinishingDeps } from './finishing.ts';
import { startRealDownload, type AriaStartDeps } from './aria-start.ts';
import { parseFlatRecord } from './kv.ts';
import type { Aria2Notification, Aria2Status } from './aria2.ts';
import type { DownloaderStore, WorkQueueEntry } from './store.ts';
import type { SourceLogger } from '../logging/logger.ts';

/**
 * "flow.inQueue": purely in-memory application state, never persisted
 * to Redis (confirmed -- no redis-command node anywhere reads or
 * writes an "inQueue"-shaped key). Incremented once per poll tick by
 * the COUNT of entries XREADGROUP returned ("inQueue" change node,
 * 660c058098466121: `$count(payload[0][1])`); decremented by exactly 1
 * for every job that reaches a terminal state -- once after Hash()
 * resolves in the Complete chain (regardless of outcome: HASH_OK,
 * HASH_NOK, or FAIL all decrement, "Hash" -> "inQueue - 1" fires in
 * parallel with "Correct ?"), and once right after StartAck acks a
 * real onDownloadError notification. Clamped at 0, matching the
 * original's `> 0 ? -1 : 0` ternary.
 */
export class InFlightCounter {
	private value = 0;
	get(): number {
		return this.value;
	}
	add(n: number): void {
		this.value += n;
	}
	release(): void {
		this.value = this.value > 0 ? this.value - 1 : 0;
	}
}

export interface ConsumerDeps {
	store: DownloaderStore;
	queue: string;
	worker: string;
	/** global "aria-inqueue" -- the "Length ?" gate's other half. */
	ariaInQueue: number;
	inFlight: InFlightCounter;
	/**
	 * downloader['aria-download'] -- the directory aria2 (and
	 * decode-write.ts's embedded-content fast path) actually writes
	 * files into. Used both to tell decode-write.ts where to write, and
	 * to recognize a real aria2 completion notification as landing in
	 * OUR download directory (see handleAriaNotification below) instead
	 * of the previous hardcoded, case-sensitive `.includes('downloads')`
	 * check.
	 */
	ariaDownloadDir: string;
	decodeWriteIo: DecodeWriteIO;
	ariaStart: AriaStartDeps;
	complete: CompleteDeps;
	finishing: FinishingDeps;
	errorRetry: ErrorRetryDeps;
	log: typeof console;
	// "Correct ?" (previous-node b5e314ab000ef77a, Warn -- the
	// HASH_NOK/FAIL branches below), "Output - Complete" (previous-node
	// c4b87207818bcacc, Debug), "Output - Error" (previous-node
	// 702b97614f9e3f0e, Debug), and "Ack" (ack.ts's own Debug, threaded
	// through from here since both startAck() call sites live in this
	// file). All optional so every existing hand-built ConsumerDeps in
	// this file's own tests keeps compiling without them.
	correctLog?: SourceLogger;
	outputCompleteLog?: SourceLogger;
	outputErrorLog?: SourceLogger;
	ackLog?: SourceLogger;
}

/** "Content ?" (0a6448e35af7e733) fan-out for one work-queue entry. */
export async function processQueueEntry(deps: ConsumerDeps, entry: WorkQueueEntry): Promise<void> {
	if (entry.content === 'true') {
		// "Extract" -> HGETALL -> "K/V" -> "Save" (msg.hget = the parsed record).
		const flat = await deps.store.getDownloaderRecord(entry.downloaderId);
		const fields = parseFlatRecord(flat);
		const outcome = runDecodeWrite({ id: entry.id, downloaderId: entry.downloaderId, href: entry.href }, fields.wnm ?? '', deps.ariaDownloadDir, deps.decodeWriteIo);

		if (outcome.kind === 'fallback') {
			await startRealDownload(deps.ariaStart, { id: entry.id, downloaderId: entry.downloaderId, href: entry.href, topic: entry.topic });
			return;
		}

		// stream_id === gid on this fast path (see decode-write.ts's header comment).
		const flatFields = [
			'stream_id',
			outcome.gid,
			'downloader_id',
			entry.downloaderId,
			'download_entry_id',
			entry.id,
			'href',
			entry.href,
			'filename',
			outcome.filename,
		];
		await deps.store.setAria2GidFields(deps.worker, outcome.gid, flatFields);

		const acked = await startAck(deps.store, deps.queue, deps.worker, outcome.gid, deps.ackLog);
		if (!acked) return; // "First ?" rejected -- log-only in the original, no further action

		await runCompletion(deps, acked.downloaderId, outcome.gid, outcome.filepath);
		return;
	}

	await startRealDownload(deps.ariaStart, { id: entry.id, downloaderId: entry.downloaderId, href: entry.href, topic: entry.topic });
}

/** Shared by the Decode & Write fast path and the real-aria2 onDownloadComplete handler: runs complete.ts and routes on its hashOutcome, always releasing one in-flight slot regardless of outcome. */
async function runCompletion(deps: ConsumerDeps, downloaderId: string, gid: string, filepath: string): Promise<void> {
	const completeOutcome = await runComplete(deps.complete, downloaderId, gid, filepath);
	deps.inFlight.release();
	if (!completeOutcome) return;

	if (completeOutcome.hashOutcome === 'HASH_OK') {
		await runFinishing(
			deps.finishing,
			completeOutcome.downloaderId,
			completeOutcome.wnm,
			completeOutcome.wnmTopic,
			completeOutcome.href,
			completeOutcome.localHref ?? '',
			completeOutcome.uri ?? '',
			completeOutcome.length,
		);
	} else if (completeOutcome.hashOutcome === 'HASH_NOK') {
		// "Correct ?" (Warn): the original's own switch routes both its
		// HASH_NOK and FAIL branches to this same logIO call (see below).
		deps.correctLog?.warn({ downloaderId: completeOutcome.downloaderId, hashOutcome: completeOutcome.hashOutcome });
		await reportBadHash(deps.errorRetry, completeOutcome.wnmTopic);
		void runRetryDecision(deps.errorRetry, completeOutcome.downloaderId).catch((err) =>
			deps.log.error(`downloader: retry decision failed for ${completeOutcome.downloaderId}: ${err instanceof Error ? err.message : String(err)}`),
		);
	} else {
		// 'FAIL': no further action beyond the "Correct ?" Warn above --
		// matches "Correct ?"'s FAIL branch, a dead-end "File Exists" link
		// out with no wires (an original-behavior gap: an S3-upload
		// failure or a rename-target collision is simply abandoned, not
		// retried or reported. Ported as-is, not fixed -- this wasn't one
		// of the specific ambiguities the maintainer resolved this phase.)
		deps.correctLog?.warn({ downloaderId: completeOutcome.downloaderId, hashOutcome: completeOutcome.hashOutcome });
	}
}

/**
 * aria2's pushed onDownloadComplete/onDownloadError notifications
 * ("Back" switch's first two branches -> "Gid" -> tellStatus -> "Status"
 * -> "Output - Complete"/"Output - Error"). Wire this as the
 * Aria2Client's onNotification callback (see run.ts).
 */
export async function handleAriaNotification(
	deps: ConsumerDeps,
	notification: Aria2Notification,
	tellStatus: (gid: string) => Promise<Aria2Status>,
): Promise<void> {
	const status = await tellStatus(notification.gid);

	if (notification.method.includes('Complete')) {
		// "Output - Complete": result.status==='complete' AND its first
		// file's path is actually under our configured download
		// directory (deps.ariaDownloadDir -- downloader['aria-download']).
		// Previously a hardcoded, case-sensitive `.includes('downloads')`
		// check, which silently never matched a real aria2.conf `dir=`
		// with different casing or naming (observed live: the maintainer's own
		// aria2.conf uses .../Aria2/Downloads, capital D).
		if (status.status !== 'complete' || !status.files[0]?.path.startsWith(deps.ariaDownloadDir)) return;
		deps.outputCompleteLog?.debug({ gid: notification.gid, status: status.status });
		const acked = await startAck(deps.store, deps.queue, deps.worker, notification.gid, deps.ackLog);
		if (!acked) return;
		await runCompletion(deps, acked.downloaderId, notification.gid, status.files[0].path);
	} else if (notification.method.includes('Error')) {
		// "Output - Error": result.status==='error'.
		if (status.status !== 'error') return;
		deps.outputErrorLog?.debug({ gid: notification.gid, status: status.status });
		const acked = await startAck(deps.store, deps.queue, deps.worker, notification.gid, deps.ackLog);
		if (!acked) return;
		deps.inFlight.release();
		await reportDownloadError(deps.errorRetry, undefined); // wnmtopic unknown at this point, matches the original
		void runRetryDecision(deps.errorRetry, acked.downloaderId).catch((err) =>
			deps.log.error(`downloader: retry decision failed for ${acked.downloaderId}: ${err instanceof Error ? err.message : String(err)}`),
		);
	}
}

/**
 * One "Init" inject tick: XINFO/"Values"/"Length ?" gate -> XREADGROUP ->
 * per-entry fan-out.
 *
 * The original's "Href" function node (db2d46c56de8a3d3) ends with
 * `return [messages];` -- a Node-RED function node returning an ARRAY
 * from one output sends every element as its own message, one after
 * another, WITHOUT waiting for a message's downstream async chain
 * (redis-command nodes, the aria2 dynamic-websocket call, ...) to
 * settle before dispatching the next one: Node-RED hands message N to
 * the next node and immediately moves on to message N+1, interleaving
 * their in-flight async work on the single event loop. So all of a
 * batch's entries were always started essentially concurrently in the
 * original -- never one full entry (registerStreamEntry + expire +
 * addUri + getStreamEntry + setAria2GidFields + scheduleCleanerCancel,
 * ~6 sequential Redis/aria2 round trips, see aria-start.ts) at a time.
 *
 * A literal `for (const entry of entries) { await
 * processQueueEntry(...); }` port does NOT have that property: each
 * entry's full ~6-round-trip chain was awaited to completion before
 * the next entry's FIRST round trip even started, serializing an
 * entire batch of up to 30 entries. Found 2026-09-11: the maintainer -- "it is
 * super slow ... I compare [messages published] with what is
 * effectively downloaded ... the difference is HUGE" -- a batch that
 * should start in roughly one round trip's worth of time was instead
 * taking up to 30x that, falling further behind the 2s poll interval
 * with every tick under any real load. Fixed by firing every entry in
 * the batch concurrently (Promise.allSettled), matching the original's
 * real per-message dispatch semantics; each entry keeps its own
 * try/catch so one failing entry still can't stop or delay the rest of
 * the batch.
 */
export async function pollOnce(deps: ConsumerDeps): Promise<void> {
	const length = await deps.store.getQueueLength(deps.queue);
	if (!(length > 0 && deps.inFlight.get() < deps.ariaInQueue)) return;

	const entries = await deps.store.readWorkQueue(deps.queue, deps.worker, 30);
	if (entries.length === 0) return;
	deps.inFlight.add(entries.length);

	await Promise.allSettled(
		entries.map(async (entry) => {
			try {
				await processQueueEntry(deps, entry);
			} catch (err) {
				deps.log.error(`downloader: failed processing work-queue entry ${entry.id} (${entry.href}): ${err instanceof Error ? err.message : String(err)}`);
			}
		}),
	);
}

export async function runConsumerLoop(deps: ConsumerDeps, signal: AbortSignal, sleep: (ms: number) => Promise<void>, pollIntervalMs = 2000): Promise<void> {
	while (!signal.aborted) {
		try {
			await pollOnce(deps);
		} catch (err) {
			if (signal.aborted) return;
			deps.log.error(`downloader: poll failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!signal.aborted) await sleep(pollIntervalMs);
	}
}
