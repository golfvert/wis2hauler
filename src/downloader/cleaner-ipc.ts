// Port of the Cleaner-IPC loop: a SEPARATE 2s poll from the main
// consumer loop (its own unnamed inject node, 2d0ae51f574c6fb6, not
// the "Init"-named 7313f19a0561886b one that drives consumer.ts) that
// reads delete/cancel commands the Cleaner role writes onto this
// worker's own command stream. "Read" (2843374246efbb12) -> XREAD ->
// "Manage" (5f45859e8c944cc7) -> "LastId" (ecfec011b1672be5) -> XTRIM.
//
// Setup tab's "Configuration" change node (ec251329e6d67f9d) initializes
// global.lastId = "0-0" -- confirmed, not assumed by analogy with
// Subscriber's lastMqttId.
import { startAck } from './ack.ts';
import { reportDownloadError, runRetryDecision, type ErrorRetryDeps } from './error-retry.ts';
import type { DownloaderStore, WorkerCommandEntry } from './store.ts';

export interface CleanerIpcDeps {
	store: DownloaderStore;
	queue: string;
	worker: string;
	errorRetry: ErrorRetryDeps;
	/** downloader['aria-download'] -- see schema.ts's doc comment. Used to reconstruct the path a 'delete' command's filename lives at, instead of a hardcoded "/downloads/" prefix. */
	ariaDownloadDir: string;
	unlinkAsync: (filepath: string) => Promise<void>;
	warn: (message: string) => void;
	sleep: (ms: number) => Promise<void>;
}

/**
 * "Manage": scans each entry's flat field array for an "action" field
 * (ported literally, including that only the FIRST "action" field per
 * entry is honored -- `break` after handling it). 'delete' unlinks
 * `<deps.ariaDownloadDir>/<filename>` (the next "filename" field after "action").
 * 'cancel' runs the entry's aria2_gid through the exact same
 * ack.startAck() every real completion/error uses, and -- confirmed
 * against flows.json (06cf1d6512292e5a's "Ack" link call wires to the
 * SAME "Error" link-out, 873388b63527db5d, that a real
 * onDownloadError notification uses) -- on success routes it into the
 * Error/retry pipeline exactly like a real download error, with no
 * wnmtopic known yet (matching the original's `$exists(wnmtopic) ?
 * wnmtopic : ""`).
 *
 * The retry decision (its 30s delay) is intentionally NOT awaited here
 * -- the original's own link-out is not a synchronous call, so this
 * loop's next poll tick isn't blocked on it either; callers that need
 * to observe completion should await the returned promise themselves.
 */
export function processCleanerCommands(deps: CleanerIpcDeps, entries: readonly WorkerCommandEntry[]): Promise<void>[] {
	const pending: Promise<void>[] = [];
	for (const entry of entries) {
		const fields = entry.fields;
		for (let i = 0; i < fields.length; i += 2) {
			if (fields[i] !== 'action') continue;
			const action = fields[i + 1];
			if (action === 'delete') {
				for (let j = i + 2; j < fields.length; j += 2) {
					if (fields[j] === 'filename') {
						const filepath = `${deps.ariaDownloadDir.replace(/\/+$/, '')}/${fields[j + 1]}`;
						pending.push(deps.unlinkAsync(filepath).catch((err) => deps.warn(`Failed to delete file ${filepath}: ${err instanceof Error ? err.message : String(err)}`)));
						break;
					}
				}
			} else if (action === 'cancel') {
				for (let j = i + 2; j < fields.length; j += 2) {
					if (fields[j] === 'aria2_gid') {
						const gid = fields[j + 1]!;
						pending.push(
							(async () => {
								const acked = await startAck(deps.store, deps.queue, deps.worker, gid);
								if (!acked) return;
								await reportDownloadError(deps.errorRetry, undefined);
								await runRetryDecision(deps.errorRetry, acked.downloaderId);
							})(),
						);
						break;
					}
				}
			}
			break;
		}
	}
	return pending;
}

/** One poll tick: XREAD, process, and (only if any entries came back) XTRIM to the last id read. Returns the cursor to pass as `lastId` next tick. */
export async function pollCleanerCommands(deps: CleanerIpcDeps, lastId: string, count = 200): Promise<string> {
	const entries = await deps.store.pollCommands(deps.worker, lastId, count);
	if (entries.length === 0) return lastId;
	await Promise.all(processCleanerCommands(deps, entries));
	const newLastId = entries[entries.length - 1]!.id;
	await deps.store.trimCommands(deps.worker, newLastId);
	return newLastId;
}

export async function runCleanerIpcLoop(deps: CleanerIpcDeps, signal: AbortSignal, startId = '0-0', pollIntervalMs = 2000, count = 200): Promise<void> {
	let lastId = startId;
	while (!signal.aborted) {
		try {
			lastId = await pollCleanerCommands(deps, lastId, count);
		} catch (err) {
			if (signal.aborted) return;
			deps.warn(`cleaner-ipc: poll failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!signal.aborted) await deps.sleep(pollIntervalMs);
	}
}
