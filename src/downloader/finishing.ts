// Port of the "Finishing" link-in chain (0149d4b8a664c59e): reached
// only when complete.ts's runComplete() returns hashOutcome ===
// 'HASH_OK'. Transitions the downloader_id hash's href field to
// 'complete' (idempotently, via lua.ts's LUA_COMPLETE) and, only if
// that transition actually found the field, fans out to 4 independent
// steps -- ported as 4 sequential try/catch-wrapped steps rather than
// the original's parallel wires. IMPORTANT, found 2026-09-11 (the maintainer:
// "metrics are completely empty"): an earlier version of this port
// sequenced the 4 steps as plain awaits with no per-step isolation,
// on the reasoning that "none of them depend on each other's result
// and sequencing them doesn't change behavior, only how errors
// surface" -- that reasoning was WRONG. A thrown error from step 1
// (the OPTIONAL local-broker cache-republish, which fails whenever
// the local broker is down or still reconnecting -- exactly the
// scenario mqtt/client.ts's connectMqttBestEffort was built to
// tolerate) aborted the whole function, silently skipping steps 2-4
// too: markDownloadComplete (the dedup flag Subscriber's claim.ts
// checks), publishCleanerReport (the ONLY thing that feeds Reporter's
// prom-client counters -- see reporter/run.ts's psubscribe handler),
// and recordInfoGranule (feeds Reporter's Caddy-driven user_download
// stats). None of those 3 have anything to do with local-broker
// connectivity. Each step below now runs in its own try/catch and
// reports its own failure via deps.error -- one optional step being
// down can never again silently prevent the other 3, independent
// steps from running, matching the original's actually-independent
// parallel wires for real this time.
import type { DownloaderStore } from './store.ts';
import type { MqttLike } from '../mqtt/types.ts';
import type { Wnm } from '../wis2/wnm.ts';
import type { SourceLogger } from '../logging/logger.ts';

export interface FinishingDeps {
	store: DownloaderStore;
	worker: string;
	/** global "centre-id" -- stamped onto the cache-republish's properties["global-cache"], same field Subscriber's publish-only outcome stamps. */
	centreId: string;
	/** PUB1/PUB2 -- whichever of global.local-broker[0]/[1] are configured (see run.ts); iterating this array IS the original's "Pub 1 ?"/"Pub 2 ?" gate. */
	publishClients: readonly MqttLike[];
	// Ports two DIFFERENT "Link" function nodes (Downloader tab,
	// previous-node 0ed8c6d2a0bdf7f2, Warn, and previous-node
	// e39be8ece5ffba63, Info) that both feed the WNM-rebuild step below,
	// so one SourceLogger instance (its .warn/.info) covers both.
	// Renamed from "Link" to "Publish" (2026-09-16, maintainer: "I don't
	// like not being the same name. Go for publish in both."), so this
	// now writes to the SAME `wis2gc-publish-<hour>.<level>.log` file
	// Subscriber's own publish-only republish (../subscriber/consumer.ts's
	// publishLog) uses, rather than two differently-named files for what
	// is conceptually the same "republished onto the local broker" event
	// -- each log line's `role` field ('DOWNLOADER' vs 'SUBSCRIBER',
	// added the same day) is what tells the two apart within that shared
	// file. Optional so every existing hand-built FinishingDeps in this
	// file's own tests keeps compiling without it.
	publishLog?: SourceLogger;
	/** Per-step failure reporting -- see this file's header. Optional so every existing hand-built FinishingDeps in this file's own tests keeps compiling without it; run.ts wires it to `(m) => log.error(\`DOWNLOADER: ${m}\`)`. */
	error?: (message: string) => void;
}

export async function runFinishing(
	deps: FinishingDeps,
	downloaderId: string,
	wnm: Wnm,
	wnmTopic: string,
	href: string,
	localHref: string,
	uri: string,
	length: number,
	// complete.ts's CompleteOutcome.localPath -- undefined for S3 (nothing
	// to ever evict) or when Hash didn't run at all. Stored on the
	// downloader_id hash as "local-path" (lua.ts's LUA_COMPLETE) purely so
	// ../cleaner/schedule.ts can read it back verbatim instead of parsing
	// it out of localHref -- see that file's header comment for why.
	localPath?: string,
): Promise<void> {
	// "HGET" (1c95d462b92b83ce) -> EVAL LUA_COMPLETE -> "Payload ?"
	// (0c9dc8d837b621d5): a Lua `false` (the href field never existed on
	// the hash) gates off everything below, matching the switch's silent
	// no-wire false branch. This step is NOT one of the 4 independent
	// ones -- it's the original's single upstream gate all 4 branch off.
	const transitioned = await deps.store.completeHref(downloaderId, href, String(Date.now()), localHref, localPath ?? '');
	if (transitioned !== 'complete') return;

	// Step 1/4: "WNM" (d430de06ba1e6656) -> "Link" chain: swap in the
	// LOCAL href on link[0] only, strip downloader_id, stamp
	// global-cache, republish under the "cache" (was "origin") topic
	// prefix onto PUB1/PUB2. OPTIONAL and best-effort (see mqtt/
	// client.ts's connectMqttBestEffort) -- isolated in its own
	// try/catch so a down/reconnecting local broker can never prevent
	// steps 2-4 below (see this file's header).
	//
	// Skipped ENTIRELY (not just a no-op loop) when there's no
	// local-broker configured at all -- added 2026-09-14 (the maintainer:
	// "If global.local-broker is absent no need to prepare new
	// Notification Message"). Before this, an empty publishClients still
	// built cacheWnm/cacheTopic/cachePayload and fired the "Link" Info/Warn
	// logs for a republish that was never going anywhere; now a deployment
	// with no local-broker (and so no downloader.download-url either --
	// see hash.ts's HashConfig.downloadUrlBase) does none of that work.
	if (deps.publishClients.length > 0) {
		try {
			const firstLink = wnm.links?.[0];
			if (!firstLink) {
				// "Link" (Warn): no link to swap the local href into -- an
				// anomaly the original still lets through (links.slice(1) alone),
				// worth flagging.
				deps.publishLog?.warn({ downloaderId, role: 'DOWNLOADER', wnmTopic, href });
			}
			const cacheWnm: Wnm = {
				...wnm,
				links: firstLink ? [{ ...firstLink, href: localHref }, ...wnm.links.slice(1)] : wnm.links,
				properties: { ...wnm.properties, 'global-cache': deps.centreId },
			};
			delete (cacheWnm as { downloader_id?: string }).downloader_id;
			const cacheTopic = wnmTopic.replace(/^origin/, 'cache');
			const cachePayload = JSON.stringify(cacheWnm);
			// "Link" (Info): the full notification message being republished
			// onto the local broker. Previously only logged `link` (the local
			// href) -- the maintainer flagged (2026-09-16, real production
			// log line pasted) that this doesn't show the notification
			// itself. `wnm` here is exactly the object `cachePayload` above
			// serializes, so this is the real published content, not a
			// derived summary of it -- `link`/`topic` are kept alongside for
			// anything already grepping/filtering on those fields. `role`
			// disambiguates this from Subscriber's own publish-only republish,
			// now sharing the same `wis2gc-publish-*` log file (see
			// FinishingDeps.publishLog's doc comment).
			deps.publishLog?.info({ downloaderId, role: 'DOWNLOADER', topic: cacheTopic, link: localHref, wnm: cacheWnm });
			for (const client of deps.publishClients) {
				try {
					await client.publish(cacheTopic, cachePayload);
				} catch (err) {
					// Precise context so whichever generic catch-all eventually
					// logs this (run.ts's aria2-notification handler, or a
					// real-aria2 caller's own try/catch) doesn't have to guess
					// what actually failed -- observed live (the maintainer, 2026-09-10):
					// with a local broker down or not yet reconnected, the
					// generic wrapper's message read "aria2 notification
					// handling failed", which reads like the notification
					// itself was the problem, not that publishing its
					// downstream cache-topic republish was.
					throw new Error(
						`local-broker publish failed (cache-topic republish, topic ${cacheTopic}): ${err instanceof Error ? err.message : String(err)}`,
						{ cause: err },
					);
				}
			}
		} catch (err) {
			deps.error?.(`Finishing (${downloaderId}): step 1/4 cache republish failed, continuing with steps 2-4: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// Step 2/4: "Complete" (8da13408293c76fb) -> "Set": the whole-message
	// completion flag Subscriber's claim.ts checks for dedup. The file
	// IS genuinely complete/cached on this worker regardless of whether
	// step 1's local-broker republish succeeded, so this must still run
	// even when step 1 failed.
	try {
		await deps.store.markDownloadComplete(downloaderId);
	} catch (err) {
		deps.error?.(`Finishing (${downloaderId}): step 2/4 mark-complete failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Step 3/4: "HGET" (6e26958ea82dc499) -> HGETALL (re-fetched fresh,
	// same as the original) -> "Prepare" (52435883cf148ace): the
	// cleaner-reporter notification is the downloader_id hash's flat
	// record with ["length", <length>] appended, $string()-serialized --
	// JSON.stringify is the literal equivalent of JSONata's $string() on
	// an array. This PUBLISH is the ONLY thing that feeds Reporter's
	// prom-client counters (see reporter/run.ts's psubscribe handler) --
	// must run independently of step 1.
	try {
		const flat = await deps.store.getDownloaderRecord(downloaderId);
		const report = JSON.stringify([...flat, 'length', String(length)]);
		await deps.store.publishCleanerReport(deps.worker, report);
	} catch (err) {
		deps.error?.(`Finishing (${downloaderId}): step 3/4 cleaner-reporter publish failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	// Step 4/4: "Info" (b1b5d1a78307d028): centreid = topic segment [3];
	// shorttopic = segments from index 6 onward, joined. Feeds Reporter's
	// Caddy-driven user_download stats -- independent of steps 1-3.
	try {
		const parts = wnmTopic.split('/');
		const centreid = parts[3] ?? '';
		const shorttopic = parts.filter((_part, i) => i >= 6).join('/');
		await deps.store.recordInfoGranule(uri, String(length), centreid, shorttopic);
	} catch (err) {
		deps.error?.(`Finishing (${downloaderId}): step 4/4 info-granule record failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}
