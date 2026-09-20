// The XREAD consumer: turns raw stream entries (written by ingest.ts)
// back into decisions and actions, by calling into the pure logic
// already built (order-links.ts, override.ts, prepare.ts,
// content-id.ts, claim.ts) and then acting on the result against
// SubscriberStore/MqttLike.
//
// One entry, one pass through: classify -> (stagger) -> override ->
// prepare -> content-id -> claim -> act. Ported field-for-field
// against nodered/flows.json's Subscriber tab (the "downloader_id" ->
// "Order links" -> "Override" -> "Prepare" -> "Exists"/"Complete ?" ->
// "Set" -> "Action ?" chain, and its four branches: "1st" (download),
// "1st + GC + No Cache" (publish-only), "Not 1st + Cache" (wait), and
// the unlabelled fourth combination that matches no switch rule at all
// (drop)).
import { reorderLinks, classifyTopic, computeDelaySeconds } from './order-links.ts';
import { evaluateOverride } from './override.ts';
import { prepareMessage } from './prepare.ts';
import { computeDownloaderId } from './content-id.ts';
import { decideClaimAction } from './claim.ts';
import { decideLineage, hasUpdateRel, LINEAGE_TTL_SECONDS } from './lineage.ts';
import { selectLink, firstOf, type Wnm } from '../wis2/wnm.ts';
import type { OverrideRule } from '../config/schema.ts';
import type { RawStreamEntry, SubscriberStore } from './store.ts';
import type { MqttLike } from '../mqtt/types.ts';
import type { SourceLogger } from '../logging/logger.ts';

// "Prepare"'s queuetopic / claim SET: EX 900. Same 900s the ingest-side
// per-message dedup uses (flows.json literal, not a coincidence worth
// re-deriving as two separate constants).
export const CLAIM_TTL_SECONDS = 900;

export interface ConsumerDeps {
	store: SubscriberStore;
	queue: string;
	overridelist: readonly OverrideRule[] | undefined;
	/** subscriber['weight-sources'], as a Map -- see order-links.ts's resolveWeight() for the two default rules. */
	weightSources: ReadonlyMap<string, number> | undefined;
	/** subscriber['weight-delay-seconds'] -- the delay-scale parameter for order-links.ts's computeDelaySeconds(). */
	weightDelaySeconds: number;
	/** Injectable Math.random() -- see order-links.ts's computeDelaySeconds() doc comment. */
	random: () => number;
	globalCacheMode: boolean;
	/** global["centre-id"] -- stamped onto the cache-republish's properties["global-cache"] and the monitoring event's "source". */
	centreId: string;
	/** PUB1/PUB2 -- used only for the 'publish-only' outcome. Whichever of the original's local-broker[0]/[1] are configured (see run.ts). */
	publishClients: readonly MqttLike[];
	log: typeof console;
	isDebugEnabled: () => boolean;
	/** Injectable so tests don't have to wait out real stagger delays. */
	sleep: (ms: number) => Promise<void>;
	now: () => Date;
	// orderLinksLog -- REMOVED, 2026-09-20: used to port the original's
	// "Order links" (Subscriber tab, previous-nodes dd90923f6ece3c99 /
	// e5adfbc3c92d7b88, Warn) function node, keyed on the static
	// "priority position" concept the weighted-source redesign
	// eliminated (see processEntry's matching removal comment). NOT
	// wired: "Q & S ?" (previous-node 04d1fbc09060ffc3, Debug) -- it
	// hangs off the process-mode live-pause gate, which (per this port's
	// own "Ready ?"-gate precedent, see run.ts's header) has never been
	// built; there's no pause decision anywhere in this file to attach a
	// log call to.
	// NOT a port of anything in flows.json -- added 2026-09-13 at the
	// maintainer's own prompting ("it still doesn't explain why not using the
	// logs. That's why debug logs are made"): every OTHER per-stage
	// event in this codebase (Aria, Correct?, Re-queue, Link, ...) is a
	// createSourceLogger() call, routed through global.log's
	// level/file config -- but until now, THIS role's own "here is what
	// SUBSCRIBER decided for this notification" event (line below,
	// `isDebugEnabled()`) only ever went through the separate,
	// unrelated `log: typeof console` parameter (plain stdout, gated by
	// the DebugController's per-role on/off flag, NOT by global.log.level/
	// .to at all) -- so turning on `global.log.level: debug` +
	// `to: file` never actually captured it into a rotating file the way
	// it captures every DOWNLOADER-side stage. This is the fix: the SAME
	// per-entry decision, also emitted through the normal structured/
	// file-routed path, so `wis2gc-decision-*.debug.log` becomes a
	// complete, file-based ledger of what SUBSCRIBER decided for every
	// notification that reached this function. Emitted at DEBUG, not
	// info -- this is NOT a port of anything in flows.json, so it
	// follows the maintainer's own level policy from scratch rather than
	// any original precedent (2026-09-13: "info is the bare minimum ...
	// debug is to be enabled when investigation is needed" -- a
	// per-notification trace is investigation detail, not a sparse
	// "is it working" signal).
	//
	// Named "Decision", not "Received" -- see ingest.ts's own
	// receivedLog for that: the maintainer pointed out (2026-09-13, same
	// conversation) that flows.json had a separate, earlier tap logging
	// literally every message received on the wire, ahead of
	// rbe/blacklist/dedup/parsing -- something this log, sitting in
	// processEntry, can NOT reconstruct on its own, since a message
	// dropped by any of ingest.ts's own filters never reaches here at
	// all. The two are complementary, not redundant: ingest.ts's
	// "Received" is the ground truth for "did anything arrive on this
	// topic", this one is "what did SUBSCRIBER do with it once parsed
	// and classified". Optional so every existing hand-built
	// ConsumerDeps in this file's own tests keeps compiling without it.
	decisionLog?: SourceLogger;
	// Added 2026-09-16 at the maintainer's request, mirroring downloader/
	// finishing.ts's own "Publish" fix from the same day: that log used
	// to record only `link` (the local href) for the DOWNLOADER's
	// cache-topic republish, which turned out not to actually show the
	// notification being published -- the maintainer asked for the full
	// message there, then asked for the same treatment here, for the
	// SUBSCRIBER's OWN local-broker publish (the 'publish-only' case
	// below). Unlike decisionLog just above, this is emitted at INFO,
	// not DEBUG: per the maintainer's own level policy ("info is the
	// bare minimum ... debug is to be enabled when investigation is
	// needed", 2026-09-13), "this Global Cache put a notification out
	// onto its own local broker" is a sparse, always-useful signal --
	// the same class of event as DOWNLOADER's own "Publish", not a
	// per-notification investigation trace like "Decision". Named
	// "Publish" -- NOT "Link" -- specifically so this writes to the
	// SAME `wis2gc-publish-<hour>.info.log` file as downloader/
	// finishing.ts's logger of the same name (the maintainer: "I don't
	// like not being the same name. Go for publish in both."); each
	// entry's `role` field ('SUBSCRIBER' here, 'DOWNLOADER' there) is
	// what tells the two apart within that shared file. NOT a port of
	// anything in flows.json (same as decisionLog). Optional for the
	// same reason as every other logger field here.
	publishLog?: SourceLogger;
	// NOT a port of anything in flows.json -- added 2026-09-17 for the
	// origin-topic data_id lineage check (see lineage.ts's header for
	// the full rationale: an origin republishing the same data_id
	// without rel=update, discovered via the maintainer's separate
	// "Sensor Global Cache" tool). Emitted at INFO per the maintainer's
	// explicit answer when asked how a caught duplicate should surface
	// ("Just logs in a duplicate log file. info level.") -- its own
	// dedicated `wis2gc-duplicate-<hour>.info.log` file, not folded
	// into decisionLog/publishLog, since this is a distinct, named
	// class of event the maintainer wants to be able to find on its
	// own. Optional for the same reason as every other logger field
	// here.
	duplicateLog?: SourceLogger;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The 'publish-only' outcome's two messages: a cache-topic republish
// of the WNM ("WNM" change node, 0891e56b3292c801) and a WIS2
// monitoring event ("Monitor" change node, 3db0281cd705b3bc). Built
// from the SAME input wnm/topic independently (the original fans the
// message out to both change nodes in parallel), so each gets its own
// copy with wnm.downloader_id stripped.
//
// Both are built here regardless of how nocache/publish-only was
// reached -- whether processEntry's caller actually PUBLISHES the
// monitor one is a separate, deliberate-deviation decision made by the
// caller (see processEntry's 'publish-only' case and override.ts's
// header comment): the WNM cache-topic republish is WIS2-Guide-
// mandatory for the Global Cache role regardless of source, the
// monitor event is not.
//
// This function itself is only ever CALLED when there's at least one
// local-broker client to publish to at all -- see processEntry's
// 'publish-only' case, gated on deps.publishClients.length > 0 since
// 2026-09-14 (the maintainer: "No WNM here either", the same treatment
// as downloader/finishing.ts's step 1/4). With no local-broker
// configured there is nothing to republish to, so there's no reason to
// build either message in the first place.
function buildPublishOnlyMessages(
	wnm: Wnm,
	topic: string,
	centreId: string,
	uuidCache: string | undefined,
	uuidMonitor: string | undefined,
	reason: string | undefined,
	now: Date,
): { cacheTopic: string; cacheWnm: Wnm; cachePayload: string; monitorTopic: string; monitorEvent: unknown; monitorPayload: string } {
	// "WNM": delete wnm.downloader_id; wnm.properties["global-cache"] = centre-id;
	// wnm.id = uuid_cache (possibly undefined -- see override.ts's header
	// comment: the original only generates uuid_cache/uuid_monitor inside
	// a matched overridelist rule, not when nocache came from
	// properties.cache alone); topic = topic with a LEADING "origin"
	// replaced by "cache" (a prefix replace, not a full segment swap).
	const { downloader_id: _drop, ...wnmRest } = wnm;
	const cacheWnm: Wnm = {
		...wnmRest,
		properties: { ...wnm.properties, 'global-cache': centreId },
		id: uuidCache as string,
	} as Wnm;
	const cacheTopic = topic.replace(/^origin/, 'cache');
	const cachePayload = JSON.stringify(cacheWnm);

	// "Monitor": delete wnm.downloader_id; originid = split(wnmtopic,"/")[3];
	// a CloudEvents-shaped WIS2 monitoring-event-message-core payload.
	const { downloader_id: _drop2, ...monitorWnmRest } = wnm;
	const originid = topic.split('/')[3] ?? '';
	const monitorEvent = {
		specversion: '1.0',
		type: 'int.wmo.wis.wme.event.item.cache',
		source: centreId,
		subject: originid,
		id: uuidMonitor,
		time: now.toISOString(),
		datacontenttype: 'application/json',
		dataschema: 'https://schemas.wmo.int/wme/1.0.0/schemas/wis2-event-message-encoding-bundled.json',
		data: {
			conformsTo: ['http://wis.wmo.int/spec/wme/1/conf/monitoring-event-message-core'],
			channel: topic,
			content: {
				title: 'Data granule not cached',
				description: reason,
				wnm: monitorWnmRest,
			},
			severity: 'INFO',
		},
	};
	const monitorTopic = `monitor/a/wis2/${originid}`;
	const monitorPayload = JSON.stringify(monitorEvent);

	return { cacheTopic, cacheWnm, cachePayload, monitorTopic, monitorEvent, monitorPayload };
}

// Shared by both lineage checks in processEntry below (origin-topic and
// cache-topic) -- see lineage.ts's header for the full rationale behind
// there being two, separately-keyed checks. `get`/`record` close over
// whichever history (origin-scoped or GC-scoped) applies; `logFields`
// carries the caller's own key parts (originCentreId or globalCache)
// into the duplicateLog line so the two cases stay distinguishable in
// the shared `wis2gc-duplicate-*.info.log` file. Returns true when the
// message was a duplicate (caller must drop it), false when it was
// new/an update (and has already been recorded).
async function checkLineageAndRecord(
	deps: ConsumerDeps,
	entry: RawStreamEntry,
	wnm: Wnm,
	dataIdRaw: string,
	get: () => Promise<string[]>,
	record: (nowMillis: number) => Promise<void>,
	logFields: Record<string, unknown>,
): Promise<boolean> {
	const pubtime = wnm.properties.pubtime;
	const knownPubtimes = await get();
	const decision = decideLineage(pubtime, hasUpdateRel(wnm), knownPubtimes);
	if (decision.kind === 'duplicate') {
		deps.duplicateLog?.info({ topic: entry.topic, dataId: dataIdRaw, pubtime, reason: decision.reason, ...logFields });
		return true;
	}
	await record(deps.now().getTime());
	return false;
}

export async function processEntry(entry: RawStreamEntry, deps: ConsumerDeps): Promise<void> {
	let wnm: Wnm;
	try {
		wnm = reorderLinks(JSON.parse(entry.payload) as Wnm);
	} catch (err) {
		deps.log.error(`consumer: malformed WNM on stream entry ${entry.id} (${entry.topic}): ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const classification = classifyTopic(entry.topic, wnm, deps.weightSources);
	// "Order links" (Warn) -- REMOVED, 2026-09-20: the original's own
	// function node fanned this message onward to a Warn-level logIO call
	// whenever it landed on output 1 (origin topics and unprioritized
	// cache topics) or output 2 (a cache topic at priority position 0),
	// ported as-is for a while after this port lost its own Node-RED
	// wiring outputs. The weighted-source redesign eliminated the static
	// "position" concept this was keyed on (there is no longer a single
	// distinguished "position 0" candidate, and "unprioritized" is now
	// just the ordinary default-weight case) -- no replacement condition
	// is invented here; deps.decisionLog below already records every
	// classified entry's outcome.
	if (classification.kind === 'ignore') {
		if (deps.isDebugEnabled()) deps.log.log(`consumer: ignoring ${entry.topic} (neither origin nor a recognized cache source)`);
		return;
	}

	// Data_id lineage checks -- see lineage.ts's header for the full
	// rationale and ConsumerDeps.duplicateLog's doc comment for the
	// logging policy. Two SEPARATE checks, against two separate
	// histories, never merged:
	if (classification.kind === 'origin') {
		// 1. An ORIGIN reusing a data_id without rel=update. Keyed by
		// (origin centre, data_id) -- originCentreId comes from the
		// topic itself (matching buildPublishOnlyMessages' own
		// `originid` derivation just below and SCGC's identical
		// `$split(topic,"/")[3]`), NOT deps.centreId -- this hash
		// tracks a PRODUCER's publishing history, not anything about
		// this GC.
		const originCentreId = entry.topic.split('/')[3] ?? '';
		const dataIdRaw = wnm.properties.data_id;
		const isDuplicate = await checkLineageAndRecord(
			deps,
			entry,
			wnm,
			dataIdRaw,
			() => deps.store.getLineagePubtimes(originCentreId, dataIdRaw),
			(nowMillis) => deps.store.recordLineagePubtime(originCentreId, dataIdRaw, wnm.properties.pubtime, nowMillis, LINEAGE_TTL_SECONDS),
			{ originCentreId },
		);
		if (isDuplicate) return;
	} else if (classification.kind === 'cache') {
		// 2. A single Global Cache repeating ITS OWN publication of a
		// data_id without rel=update -- added 2026-09-17 at the
		// maintainer's explicit follow-up ("if a GC is pushing multiple
		// times the same data_id, same pubtime and no rel=update this
		// it is a duplicate" / "if a Global Cache goes crazy, it must
		// be controlled..."). Keyed by the message's OWN `global-cache`
		// label (not the origin centre, not deps.centreId) so this
		// NEVER collides with a different GC's legitimate, independent
		// relay of the identical data_id+pubtime -- that fan-out case
		// must keep passing through untouched. Skipped entirely when
		// the message carries no (string) `global-cache` label at all
		// -- nothing to key the history on.
		const globalCache = wnm.properties['global-cache'];
		if (typeof globalCache === 'string') {
			const dataIdRaw = wnm.properties.data_id;
			const isDuplicate = await checkLineageAndRecord(
				deps,
				entry,
				wnm,
				dataIdRaw,
				() => deps.store.getGlobalCacheLineagePubtimes(globalCache, dataIdRaw),
				(nowMillis) => deps.store.recordGlobalCacheLineagePubtime(globalCache, dataIdRaw, wnm.properties.pubtime, nowMillis, LINEAGE_TTL_SECONDS),
				{ globalCache },
			);
			if (isDuplicate) return;
		}
	}

	const delaySeconds = computeDelaySeconds(classification, deps.weightDelaySeconds, deps.random);
	if (delaySeconds > 0) await deps.sleep(delaySeconds * 1000);

	const overrideResult = evaluateOverride(wnm, entry.topic, deps.overridelist);
	const prepared = prepareMessage(wnm, entry.topic, overrideResult.override);
	const downloaderId = computeDownloaderId(wnm);

	const alreadyComplete = await deps.store.isAlreadyComplete(downloaderId);
	const claimed = alreadyComplete ? false : await deps.store.claimDownload(downloaderId, CLAIM_TTL_SECONDS);

	const action = decideClaimAction({
		alreadyComplete,
		claimed,
		nocache: prepared.nocache,
		globalCacheMode: deps.globalCacheMode,
	});

	if (deps.isDebugEnabled()) deps.log.log(`consumer: ${downloaderId} (${entry.topic}) -> ${action.kind}`);
	// See ConsumerDeps.decisionLog's own doc comment: the file-routed
	// twin of the plain-console line just above, computed once here
	// (rather than duplicated inside the 'download'/'wait' cases below,
	// which used to each compute their own copy of this same href) so
	// every action.kind -- including 'drop' and 'already-complete',
	// which otherwise leave zero trace anywhere -- gets one record of
	// what SUBSCRIBER decided and why.
	const href = firstOf(selectLink(wnm)?.href) ?? '';
	deps.decisionLog?.debug({ downloaderId, topic: entry.topic, href, action: action.kind });

	switch (action.kind) {
		case 'already-complete':
			return;

		case 'download': {
			const hasContent = wnm.properties.content !== undefined;
			// The original's stored "wnm" field is the SAME payload object
			// that had payload.downloader_id set on it upstream (the
			// "downloader_id" change node mutates payload in place, and
			// nothing downstream of it on the 'download' path ever deletes
			// that field again) -- so the JSON this hash stores for the
			// Downloader role to read carries downloader_id embedded,
			// unlike the publish-only path's republished copy.
			const wnmJson = JSON.stringify({ ...wnm, downloader_id: downloaderId });
			await Promise.all([
				deps.store.writeDownloadJob(downloaderId, href, prepared.source, wnmJson, entry.topic, wnm.properties.pubtime),
				deps.store.enqueueWork(deps.queue, downloaderId, href, entry.topic, hasContent),
			]);
			return;
		}

		case 'wait': {
			await deps.store.recordWait(downloaderId, href, prepared.source);
			return;
		}

		case 'drop':
			return;

		case 'publish-only': {
			await deps.store.initAttempt(downloaderId);
			// Skipped ENTIRELY (not just an empty flatMap producing nothing to
			// await) when there's no local-broker configured at all -- added
			// 2026-09-14 (the maintainer, same request/reasoning as
			// downloader/finishing.ts's step 1/4 gate: "No WNM here either").
			// Before this, an empty publishClients still built cacheWnm/
			// cachePayload and, on an overridelist match, the CloudEvents
			// monitor payload too, for a republish that was never going
			// anywhere.
			if (deps.publishClients.length > 0) {
				const { cacheTopic, cacheWnm, cachePayload, monitorTopic, monitorEvent, monitorPayload } = buildPublishOnlyMessages(
					wnm,
					entry.topic,
					deps.centreId,
					overrideResult.uuidCache,
					overrideResult.uuidMonitor,
					overrideResult.reason,
					deps.now(),
				);
				// DELIBERATE DEVIATION, 2026-09-11 (confirmed with the maintainer across
				// several rounds -- see the project notes for the full
				// back-and-forth): the WIS2 monitoring event ("Data granule
				// not cached") is emitted ONLY when this GC itself decided
				// (via an overridelist match) not to cache something an
				// origin wanted cached in the first place. It is NOT emitted
				// when the origin itself already declared
				// wnm.properties.cache === false -- there's nothing for a
				// monitor to usefully report there (the origin already said
				// so), regardless of whether an overridelist rule ALSO
				// happens to match the same message. flows.json's own
				// "Action ?" rule 1 got this wrong in the original too (the maintainer:
				// "My flows.json had a bug too" -- it published Monitor
				// whenever nocache was true for ANY reason, never rechecking
				// wnm.properties.cache first) -- this is a corrected
				// reimplementation of the *intended* WIS2 Guide behavior, not
				// a faithful port of that rule. The WNM cache-topic republish
				// just above is NOT part of this at all -- it stays
				// unconditional on nocache alone (cache:false OR override),
				// since the WIS2 Guide requires a Global Cache to keep
				// republishing a (new) notification on cache/... whenever it
				// isn't caching the data, regardless of why it isn't.
				const emitMonitorEvent = overrideResult.override && wnm.properties.cache !== false;
				// "Publish" (Info): the full notification message(s) this
				// Global Cache is republishing onto the local broker -- same
				// fix, same day, as downloader/finishing.ts's own "Publish"
				// (renamed from "Link" 2026-09-16, same request: "Go for
				// publish in both"): see ConsumerDeps.publishLog's doc
				// comment. `wnm`/`monitor` are exactly the objects
				// `cachePayload`/`monitorPayload` above serialize, so this is
				// the real published content. `monitor` is only present when
				// emitMonitorEvent is true -- there's nothing published under
				// that topic otherwise. `role` disambiguates this from
				// Downloader's own entries in the same shared
				// `wis2gc-publish-*` log file.
				deps.publishLog?.info({
					downloaderId,
					role: 'SUBSCRIBER',
					topic: cacheTopic,
					wnm: cacheWnm,
					...(emitMonitorEvent ? { monitorTopic, monitor: monitorEvent } : {}),
				});
				const publishCalls = deps.publishClients.flatMap((client) => {
					const calls = [client.publish(cacheTopic, cachePayload)];
					if (emitMonitorEvent) calls.push(client.publish(monitorTopic, monitorPayload));
					return calls;
				});
				try {
					await Promise.all(publishCalls);
				} catch (err) {
					// Logged, NOT rethrown -- found 2026-09-11 alongside the
					// identical bug in downloader/finishing.ts (see that
					// file's header): rethrowing here let runConsumerLoop's
					// generic per-entry catch abort this case entirely,
					// silently skipping the releaseClaim() call below. Since
					// runConsumerLoop already advances `lastId` past this
					// entry unconditionally (see its own loop), a skipped
					// releaseClaim wasn't just delayed, it was gone for this
					// entry -- defeating the exact "don't leave it blocking a
					// future real download" fix the maintainer asked for when
					// store.ts's releaseClaim was written. A down/reconnecting
					// local broker (mqtt/client.ts's connectMqttBestEffort)
					// must never prevent this claim release.
					const topics = emitMonitorEvent ? `${cacheTopic}/${monitorTopic}` : cacheTopic;
					deps.log.error(
						`consumer: local-broker publish failed (publish-only outcome for ${downloaderId}, topics ${topics}): ${err instanceof Error ? err.message : String(err)} -- releasing claim regardless`,
					);
				}
			}
			// Unconditional, not gated on PUB1 being configured (nor, now,
			// on the publish above having succeeded) -- see store.ts's
			// releaseClaim doc comment for why (the original's equivalent
			// DEL never actually fires, per the maintainer's "Fix it (recommended)"
			// decision when asked about this).
			await deps.store.releaseClaim(downloaderId);
			return;
		}
	}
}

/**
 * Runs the XREAD polling loop until aborted. startId defaults to
 * "0-0" -- the original's Setup-tab "Configuration" change node
 * initializes global.lastMqttId to the literal string "0-0" (i.e. read
 * the WHOLE stream from the start on startup), not "$" (only-new).
 *
 * Entries in a batch are processed CONCURRENTLY, not one at a time --
 * same class of bug, same fix shape, as downloader/consumer.ts's
 * pollOnce (see that function's own doc comment for the full Node-RED
 * dispatch-semantics argument: an mqtt-in-driven original never
 * serializes independent messages behind one another either). Found
 * 2026-09-11 as a second bottleneck in the same session, after fixing
 * the downloader side alone made no visible difference to the maintainer ("Still
 * extremely slow... changed aria-inqueue to 32, no visible
 * difference") -- a clear sign the real constraint was upstream of
 * aria2 entirely: raw MQTT ingest (ingest.ts) already dispatches
 * concurrently per message (see run.ts's `void handler(...)`), but
 * this loop was re-serializing everything right back on the way OUT
 * of the raw stream and INTO the downloader's work queue, so queue1
 * itself was never being filled fast enough for any amount of
 * downloader/aria2 concurrency downstream to matter.
 *
 * This one is worse than the downloader case in a second way:
 * processEntry() can itself `await deps.sleep(delaySeconds * 1000)`
 * for a randomized, unbounded-above duration (order-links.ts's
 * computeDelaySeconds -- an exponential draw scaled by
 * `weight-delay-seconds` / this candidate's weight, applied to any
 * classified origin or cache entry, not just a distinguished
 * "priority" one) -- under the old sequential loop, ANY delayed message
 * anywhere in a batch of up to 500 would block every other entry after
 * it for that whole delay, every single poll tick.
 */
export async function runConsumerLoop(deps: ConsumerDeps, signal: AbortSignal, startId = '0-0', pollIntervalMs = 1000, count = 500): Promise<void> {
	let lastId = startId;
	while (!signal.aborted) {
		let entries: RawStreamEntry[];
		try {
			entries = await deps.store.readRawMessages(deps.queue, lastId, count);
		} catch (err) {
			if (signal.aborted) return;
			deps.log.error(`consumer: XREAD failed: ${err instanceof Error ? err.message : String(err)}`);
			await deps.sleep(pollIntervalMs);
			continue;
		}
		// Advance past the whole batch up front, unconditionally -- same
		// end state the old sequential loop always reached (it set
		// lastId on every entry regardless of outcome, landing on the
		// last one), just computed without needing the loop itself.
		if (entries.length > 0) lastId = entries[entries.length - 1]!.id;

		await Promise.allSettled(
			entries.map(async (entry) => {
				if (!entry.topic || !entry.payload) return; // matches the original's "Process" function skipping fieldless entries
				try {
					await processEntry(entry, deps);
				} catch (err) {
					deps.log.error(`consumer: failed processing ${entry.id} (${entry.topic}): ${err instanceof Error ? err.message : String(err)}`);
				}
			}),
		);
		if (entries.length === 0 && !signal.aborted) await deps.sleep(pollIntervalMs);
	}
}
