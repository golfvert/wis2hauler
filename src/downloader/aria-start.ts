// Starts one real aria2 download for a single href -- the "Aria"
// change node's HSET/Expire pair plus the actual aria2.addUri call and
// its "Map"/"Aria2"/"Cancel" promotion once aria2 answers with a gid.
// Shared by 2 call sites: the main consumer loop (consumer.ts, for a
// fresh work-queue entry whose content flag is "false", or whose
// content flag is "true" but decode-write.ts fell back), and the
// retry-exhausted-a-wait-href path (error-retry.ts's "Re-queue", which
// confirmed against flows.json feeds the exact same "Aria" change node
// via link-in 13, id 3245ad0eb0dabc05 -- retried hrefs always go
// through the real aria2 path, never the embedded-content fast path).
//
// CORRELATION NOTE: the original sets the JSON-RPC "id" of the addUri
// call to the stream_id itself (not aria2.ts's hardcoded tellStatus
// "1"), so that once aria2 answers, "Map" (507d242508715d48) can read
// `stream_id = payload.id` back off the echoed response id. This
// port's Aria2Client (aria2.ts) doesn't need that trick: it already
// resolves addUri()'s own Promise with the gid, and the caller here
// already has `streamId` in a closure variable at that point -- so the
// gid-promotion step below reads the pre-registered record back by the
// streamId it already knows, rather than re-deriving it from an echoed
// id field. Same end state, simpler mechanism, a direct consequence of
// the single-WebSocket redesign the maintainer chose -- not a guess about what
// the original does.
import type { Aria2Client } from './aria2.ts';
import type { DownloaderStore } from './store.ts';
import type { SourceLogger } from '../logging/logger.ts';

export interface AriaStartEntry {
	/**
	 * Combined with a random suffix (randomStreamSuffix) to mint THIS
	 * attempt's stream_id -- any unique value works structurally here.
	 * For a fresh work-queue entry (consumer.ts) this IS the work-queue
	 * stream entry id (msg.downloads.id); for a retried href
	 * (error-retry.ts) it's a synthetic re-queue id that was never
	 * itself XADD'd to the work queue. See workQueueEntryId below for
	 * why that distinction matters.
	 */
	id: string;
	downloaderId: string;
	href: string;
	topic: string;
	/** WorkQueueEntry.dataId (or '' for a retry -- error-retry.ts's runRetryDecision now reads it off the downloader_id hash record's own `data_id` field, see store.ts's doc comments). Threaded through purely for ariaLog below and the registered stream_id/aria2_gid records. NOT a port (2026-09-20). */
	dataId: string;
	/**
	 * The real work-queue stream entry id to XACK/XDEL once this
	 * attempt reaches ack.ts's startAck() -- omit for a retry.
	 *
	 * Found 2026-09-13: error-retry.ts's runRetryDecision() already
	 * XACK's/XDEL's the ORIGINAL work-queue entry back when this
	 * download first failed (via the startAck() call that routed it
	 * into the retry pipeline in the first place), then starts the
	 * retried href under a brand-new synthetic id
	 * (`${Date.now()}-99-${randomSixDigits}`, run.ts's mintRequeueId)
	 * that was never itself a real work-queue entry. Passing that
	 * synthetic id through as this attempt's download_entry_id too (the
	 * literal-port behavior) meant that once the RETRY completed,
	 * startAck() issued a real XACK/XDEL against Redis for an id that
	 * both (a) never existed in the work-queue stream and (b) isn't
	 * even shaped like a valid Redis stream id (3 dash-separated
	 * segments, not 2) -- guaranteeing
	 * "ERR Invalid stream ID specified as stream command argument" on
	 * every single retried download's completion. Leaving this field
	 * unset for a retry (registerStreamEntry below then stores '')
	 * tells ack.ts's startAck() there is no real queue entry left to
	 * ack, skipping those two calls entirely instead of issuing a
	 * doomed one.
	 */
	workQueueEntryId?: string;
}

export interface AriaStartDeps {
	store: DownloaderStore;
	worker: string;
	aria2: Aria2Client;
	/** global "download-creds", keyed by topic -- see the "Credentials" 10s sync (credentials.ts). */
	credentials: () => Readonly<Record<string, { username: string; password: string }>> | undefined;
	/** global "aria-check-tls" -- omitted from addUri's params entirely when undefined (see aria2.ts's addUri doc). */
	checkCertificate: boolean | undefined;
	/** Math.floor(Math.random() * 1000000), stringified -- injectable for deterministic tests. */
	randomStreamSuffix: () => string;
	// "Aria" (Downloader tab, previous-node e366e89cefe85791, Debug) --
	// the change node this whole function ports. Optional so every
	// existing hand-built AriaStartDeps in this file's own tests keeps
	// compiling without it.
	ariaLog?: SourceLogger;
}

export async function startRealDownload(deps: AriaStartDeps, entry: AriaStartEntry): Promise<void> {
	const streamId = `${entry.id}-${deps.randomStreamSuffix()}`;
	// NOT a port -- the original (and this port until 2026-09-19) built
	// this from `${downloaderId's content-derived tail}_${href's basename}`,
	// which is NOT guaranteed unique: computeDownloaderId's tail falls
	// back to just the WNM's pubtime digits whenever there's no integrity
	// block, and only the href's basename (not its full path) is used --
	// so two genuinely different files (different centres, different
	// source subdirectories) can land on the exact same aria2 `out` path.
	// That matters a lot more than it would with stock aria2: the
	// deployed image (golfvert/aria2, per its entrypoint.sh) sets
	// allow-overwrite=true and auto-file-renaming=false by DEFAULT
	// (opposite of upstream aria2's own defaults), and the Deployment
	// repo's compose file doesn't override either -- so a same-name
	// collision here isn't rejected or renamed by aria2, it's a SILENT
	// overwrite on disk, possibly while the first download is still being
	// written or hashed. Using streamId (already unique per attempt --
	// entry.id + a random suffix) instead removes the collision
	// possibility at the source, regardless of aria2's overwrite
	// behavior. Per the maintainer, 2026-09-19: "avoid collision in
	// aria2, in rename and in content" -- this is the aria2 half; see
	// hash.ts (rename) and decode-write.ts (content) for the other two.
	const filename = `${streamId}_${entry.href.split('/').pop()}`;

	// "Aria" -> HSET (register) + Expire -> SET (expire), fanned from the
	// same change node in the original -- fired concurrently here.
	await Promise.all([
		deps.store.registerStreamEntry(deps.worker, streamId, {
			streamId,
			downloaderId: entry.downloaderId,
			downloadEntryId: entry.workQueueEntryId ?? '',
			href: entry.href,
			filename,
			dataId: entry.dataId,
		}),
		deps.store.expireStreamEntry(deps.worker, streamId),
	]);

	const creds = deps.credentials()?.[entry.topic];
	const gid = await deps.aria2.addUri(entry.href, {
		filename,
		checkCertificate: deps.checkCertificate,
		credentials: creds,
	});
	deps.ariaLog?.debug({ dataId: entry.dataId, downloaderId: entry.downloaderId, href: entry.href, filename, gid, hasCredentials: creds !== undefined });

	// "Map" -> HGETALL -> "Aria2" -> HSET -> "Cancel" -> ZADD: promote the
	// pre-registration record to the gid-keyed hash, verbatim, then
	// schedule the 7-minute cancel safety net.
	const flat = await deps.store.getStreamEntry(deps.worker, streamId);
	await deps.store.setAria2GidFields(deps.worker, gid, flat);
	await deps.store.scheduleCleanerCancel(deps.worker, gid);
}
