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
	/** The work-queue stream entry id (msg.downloads.id) -- first half of the minted stream_id. */
	id: string;
	downloaderId: string;
	href: string;
	topic: string;
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
	const filename = `${entry.downloaderId.split(':').pop()}_${entry.href.split('/').pop()}`;

	// "Aria" -> HSET (register) + Expire -> SET (expire), fanned from the
	// same change node in the original -- fired concurrently here.
	await Promise.all([
		deps.store.registerStreamEntry(deps.worker, streamId, {
			streamId,
			downloaderId: entry.downloaderId,
			downloadEntryId: entry.id,
			href: entry.href,
			filename,
		}),
		deps.store.expireStreamEntry(deps.worker, streamId),
	]);

	const creds = deps.credentials()?.[entry.topic];
	const gid = await deps.aria2.addUri(entry.href, {
		filename,
		checkCertificate: deps.checkCertificate,
		credentials: creds,
	});
	deps.ariaLog?.debug({ href: entry.href, filename, gid, hasCredentials: creds !== undefined });

	// "Map" -> HGETALL -> "Aria2" -> HSET -> "Cancel" -> ZADD: promote the
	// pre-registration record to the gid-keyed hash, verbatim, then
	// schedule the 7-minute cancel safety net.
	const flat = await deps.store.getStreamEntry(deps.worker, streamId);
	await deps.store.setAria2GidFields(deps.worker, gid, flat);
	await deps.store.scheduleCleanerCancel(deps.worker, gid);
}
