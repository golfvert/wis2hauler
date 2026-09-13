// Port of the "Complete" link-in chain (040e2ff80605b0c9): reached
// once a download's queue entry has been ack'd (ack.ts's startAck())
// -- either after a real aria2 completion or directly from the
// embedded-content fast path (decode-write.ts). Rebuilds the WNM from
// the downloader_id hash record Subscriber originally wrote, cleans up
// the aria2_gid bookkeeping this specific attempt used, and runs
// hash.ts's runHash() against the file on disk.
import { parseFlatRecord } from './kv.ts';
import { runHash, HashReadError, RenameIoError, type HashConfig, type HashIO, type HashOutcome } from './hash.ts';
import type { DownloaderStore } from './store.ts';
import { firstOf, type Wnm } from '../wis2/wnm.ts';
import type { SourceLogger } from '../logging/logger.ts';

export interface CompleteDeps {
	store: DownloaderStore;
	worker: string;
	hashConfig: HashConfig;
	hashIo: HashIO;
	newUuid: () => string;
	// "Duplicates" (Downloader tab, previous-node b632c75a30bcbb2b,
	// Debug) -- a `catch` node in the original, matching the
	// RenameIoError/HashReadError branch below (the maintainer's own routing
	// decision for what the original lets escape uncaught). Optional so
	// every existing hand-built CompleteDeps in this file's own tests
	// keeps compiling without it.
	duplicatesLog?: SourceLogger;
}

export interface CompleteOutcome {
	hashOutcome: HashOutcome;
	downloaderId: string;
	/**
	 * The rebuilt WNM: a fresh `id` (the original's "K/V + UUID" step),
	 * `links[0].href` still the ORIGINAL remote href (unlike Finishing's
	 * own separate "WNM" node, which is what swaps in the local href),
	 * and `downloader_id` RETAINED on this in-memory copy -- unlike
	 * Subscriber's publish-only republish, which strips it. Something
	 * downstream (finishing.ts) is what deletes it, matching the
	 * original's "WNM" change node inside the Finishing chain, not this
	 * one.
	 */
	wnm: Wnm;
	wnmTopic: string;
	/** wnm.links[0].href -- the ORIGINAL remote href, needed by finishing.ts's completeHref() call. */
	href: string;
	length: number;
	/** Only set when hashOutcome === 'HASH_OK'. */
	localHref?: string;
	uri?: string;
	/** hashResult.localPath -- see hash.ts's HashResult doc comment. undefined for S3 (and non-HASH_OK outcomes). */
	localPath?: string;
}

interface StoredWnmShape {
	type?: string;
	downloader_id?: string;
	geometry?: unknown;
	properties: Wnm['properties'];
	links: Wnm['links'];
}

/**
 * Returns null when the downloader_id hash record has no "wnm" field
 * at all, or it doesn't parse as JSON -- a malformed/already-cleaned-up
 * record. The original has no guard here (payload.wnm is read straight
 * into `$eval(...)`, which would throw uncaught on bad input); this is
 * a defensive addition for a case flows.json never exercises on
 * purpose, not a literal port of specific original behavior.
 */
export async function runComplete(deps: CompleteDeps, downloaderId: string, gid: string, filepath: string): Promise<CompleteOutcome | null> {
	const flat = await deps.store.getDownloaderRecord(downloaderId);
	const fields = parseFlatRecord(flat);
	if (!fields.wnm) return null;

	let stored: StoredWnmShape;
	try {
		stored = JSON.parse(fields.wnm) as StoredWnmShape;
	} catch {
		return null;
	}

	// "WNM" (98655394a299da9d): rebuild with a fresh id, WMO core
	// conformsTo, and only the fields the original explicitly re-lists
	// (type/downloader_id/geometry/properties/links) -- anything else the
	// stored WNM happened to carry is dropped, matching the literal
	// object-literal rebuild rather than a spread of the whole thing.
	const wnm: Wnm = {
		id: deps.newUuid(),
		type: stored.type as never,
		downloader_id: stored.downloader_id,
		conformsTo: ['http://wis.wmo.int/spec/wnm/1/conf/core'],
		geometry: stored.geometry,
		properties: stored.properties,
		links: stored.links,
	} as Wnm;

	const method: string | null = wnm.properties?.integrity?.method ?? null;
	const hash: string | number = wnm.properties?.integrity?.value ?? 0;
	const href = firstOf(wnm.links?.[0]?.href) ?? '';
	const wnmTopic = fields.topic ?? '';

	await Promise.all([
		deps.store.deleteAria2GidRecord(deps.worker, gid),
		deps.store.deleteAria2GidExpire(deps.worker, gid),
		deps.store.unscheduleCleanerCancel(deps.worker, gid),
	]);

	let hashResult: { outcome: HashOutcome; length: number; localhref?: string; uri?: string; localPath?: string };
	try {
		hashResult = await runHash(
			{ method, hash, filepath, wnmpubtime: wnm.properties?.pubtime, wnmtopic: wnmTopic },
			deps.hashConfig,
			deps.hashIo,
		);
	} catch (err) {
		// Per the maintainer's decision (this phase's second AskUserQuestion): a
		// genuine rename-IO or hash-read failure -- which the original
		// lets escape as an uncaught exception, silently dropping the job
		// via its "Duplicates" catch node -- is routed into the SAME
		// retry/error pipeline as an ordinary HASH_NOK instead of being
		// swallowed.
		if (err instanceof RenameIoError || err instanceof HashReadError) {
			deps.duplicatesLog?.debug({ downloaderId, filepath, error: err.message });
			hashResult = { outcome: 'HASH_NOK', length: 0 };
		} else {
			throw err;
		}
	}

	return {
		hashOutcome: hashResult.outcome,
		downloaderId,
		wnm,
		wnmTopic,
		href,
		length: hashResult.length,
		localHref: hashResult.localhref,
		uri: hashResult.uri,
		localPath: hashResult.localPath,
	};
}
