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
import { reorderLinks, classifyTopic, staggerDelaySeconds } from './order-links.ts';
import { evaluateOverride } from './override.ts';
import { prepareMessage } from './prepare.ts';
import { computeDownloaderId } from './content-id.ts';
import { decideClaimAction } from './claim.ts';
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
	priorityGlobalCache: readonly string[] | undefined;
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
	// "Order links" (Subscriber tab, previous-nodes dd90923f6ece3c99 /
	// e5adfbc3c92d7b88, Warn) -- see processEntry() below. Optional so
	// every existing hand-built ConsumerDeps in this file's own tests
	// keeps compiling without it. NOT wired: "Q & S ?" (previous-node
	// 04d1fbc09060ffc3, Debug) -- it hangs off the process-mode
	// live-pause gate, which (per this port's own "Ready ?"-gate
	// precedent, see run.ts's header) has never been built; there's no
	// pause decision anywhere in this file to attach a log call to.
	orderLinksLog?: SourceLogger;
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
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The 'publish-only' outcome's two messages: a cache-topic republish
// of the WNM ("WNM" change node, 0891e56b3292c801) and a WIS2
// monitoring event ("Monitor" change node, 3db0281cd705b3bc). Built
// from the SAME input wnm/topic independently (the original fans the
// message out to both change nodes in parallel), so each gets its own
// copy with wnm.downloader_id stripped.
//
// Both are still BUILT here regardless of how nocache/publish-only was
// reached -- whether processEntry's caller actually PUBLISHES the
// monitor one is a separate, deliberate-deviation decision made by the
// caller (see processEntry's 'publish-only' case and override.ts's
// header comment): the WNM cache-topic republish is WIS2-Guide-
// mandatory for the Global Cache role regardless of source, the
// monitor event is not.
function buildPublishOnlyMessages(
	wnm: Wnm,
	topic: string,
	centreId: string,
	uuidCache: string | undefined,
	uuidMonitor: string | undefined,
	reason: string | undefined,
	now: Date,
): { cacheTopic: string; cachePayload: string; monitorTopic: string; monitorPayload: string } {
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

	return { cacheTopic, cachePayload, monitorTopic, monitorPayload };
}

export async function processEntry(entry: RawStreamEntry, deps: ConsumerDeps): Promise<void> {
	let wnm: Wnm;
	try {
		wnm = reorderLinks(JSON.parse(entry.payload) as Wnm);
	} catch (err) {
		deps.log.error(`consumer: malformed WNM on stream entry ${entry.id} (${entry.topic}): ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const classification = classifyTopic(entry.topic, wnm, deps.priorityGlobalCache);
	// "Order links" (Warn): the original's own function node fans this
	// same message onward to a Warn-level logIO call whenever it lands on
	// output 1 (origin topics AND cache topics with no priority-global-
	// cache configured at all -- both share one output, see the session's
	// flows.json trace) or output 2 (a cache topic at priority position
	// 0, the highest-priority Global Cache repeater) -- ported as-is, not
	// judged: every one of these outcomes is Warn severity in the
	// original regardless of being ordinary traffic.
	if (classification.kind === 'origin' || classification.kind === 'cache-unprioritized') {
		deps.orderLinksLog?.warn({ topic: entry.topic, classification: classification.kind });
	} else if (classification.kind === 'cache' && classification.position === 0) {
		deps.orderLinksLog?.warn({ topic: entry.topic, classification: classification.kind, position: classification.position });
	}
	if (classification.kind === 'ignore') {
		if (deps.isDebugEnabled()) deps.log.log(`consumer: ignoring ${entry.topic} (neither origin nor a recognized cache source)`);
		return;
	}

	const staggerSeconds = staggerDelaySeconds(classification);
	if (staggerSeconds > 0) await deps.sleep(staggerSeconds * 1000);

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
			const { cacheTopic, cachePayload, monitorTopic, monitorPayload } = buildPublishOnlyMessages(
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
 * processEntry() can itself `await deps.sleep(staggerSeconds * 1000)`
 * for 1-8s (order-links.ts's CACHE_STAGGER_SECONDS, only when
 * `priority-global-cache` is configured) -- under the old sequential
 * loop, ANY cache-priority message anywhere in a batch of up to 500
 * would block every other entry after it for that whole delay, every
 * single poll tick.
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
