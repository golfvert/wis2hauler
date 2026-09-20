// The raw MQTT ingest stage: turns messages arriving on a GB1/GB2
// connection into entries on the shared raw stream the XREAD consumer
// (consumer.ts) reads from. Ported field-for-field from the Node-RED
// Subscriber tab's per-connection chain: mqtt-in -> [GB2 only: a fixed
// 2s per-message delay] -> rbe -> Black & GRep (blacklist) -> Save
// (SETNX dedup key/value) -> SET -> "OK ?" -> Prepare -> XADD.
//
// One behavior the original's GB1/GB2 chains do NOT share, preserved
// here exactly rather than unified: GB2 delays every message 2s (a
// *fixed per-message* delay node -- independent per message, not a
// queue/stagger) before rbe even sees it; GB1 has no such delay. See
// run.ts's preDelayMs.
//
// A SECOND asymmetry used to live here too -- GB1's blacklist ("Black
// & GRep", b1e017aa86e0e4b3) appended RECOMMENDED_TOPIC_BLACKLIST_RULE
// when global-cache mode was on; GB2's ("Black &. GRep",
// 53702cb0bee173b8) did not. FIXED 2026-09-19 (the maintainer, after
// this was surfaced as a likely bug rather than a deliberate design):
// no rationale for the asymmetry was ever found anywhere in the
// original flow or this port, and the two Node-RED node names differ
// by only a stray typo ("&" vs "&."), the telltale sign of an
// incomplete copy-paste rather than an intentional divergence. The
// rule is now applied identically to both connections -- see run.ts's
// single effectiveBlacklist, which both GB1 and GB2 now share.
import type { Wnm } from '../wis2/wnm.ts';
import { isBlacklisted, stripReplayPrefix } from '../wis2/topic-match.ts';
import type { SubscriberStore } from './store.ts';
import type { SourceLogger } from '../logging/logger.ts';

// "Save": [ "wis2gc:subscriber:wnmid:" & id, true, "NX", "EX", 900 ].
export const MESSAGE_ID_DEDUP_TTL_SECONDS = 900;

// The WIS2-recommended-topic exemption, appended to BOTH GB1's and
// GB2's blacklist when global-cache mode is on (flows.json's
// b1e017aa86e0e4b3 -- GB1-only there; see this file's header comment
// for why the port made this symmetric instead of preserving that).
export const RECOMMENDED_TOPIC_BLACKLIST_RULE = '+/+/+/+/+/recommended/#';

// NOT a port -- added 2026-09-19 after a real report that
// ../config/topics.ts's enforceCoreCacheRule (since removed, see that
// file's own comment) was a no-op against anything but the exact
// literal string 'origin/.../core/...' in the config: a whitelist
// entry as broad as 'origin/a/wis2/#' subscribed this replica to core
// data straight from origin regardless, and nothing downstream ever
// re-checked a message's ACTUAL topic once it arrived -- it downloaded
// completely normally. Per the WIS2 spec, only a Global Cache
// (global.global-cache: true) is meant to pull 'core' data or
// dataset-discovery 'metadata' notifications directly from origin, in
// order to republish them under cache/... for everyone else; every
// other replica should only ever see 'recommended' data straight from
// origin. These two patterns are appended to every subscriber
// connection's blacklist below (see run.ts) whenever global-cache mode
// is off, so isBlacklisted() -- which runs against each message's
// real, received topic, not the configured whitelist string -- drops
// them regardless of how broadly the whitelist itself is written. The
// whitelist/blacklist as configured are no longer auto-rewritten at
// all; this is the sole enforcement now, and it's logged once at
// SUBSCRIBER startup so it's never a silent surprise.
export const ORIGIN_CORE_BLACKLIST_RULE = 'origin/+/+/+/data/core/#';
export const ORIGIN_METADATA_BLACKLIST_RULE = 'origin/+/+/+/metadata/#';

export interface IngestDeps {
	store: SubscriberStore;
	queue: string;
	/** The connection's effective blacklist -- the configured blacklist plus RECOMMENDED_TOPIC_BLACKLIST_RULE (global-cache mode on) or ORIGIN_CORE_BLACKLIST_RULE/ORIGIN_METADATA_BLACKLIST_RULE (global-cache mode off), identically for GB1 and GB2 -- see run.ts's single effectiveBlacklist. */
	blacklist: readonly string[];
	/** e.g. "GB1" / "GB2" -- for log/debug lines only. */
	sourceLabel: string;
	/** GB2's fixed 2s per-message delay in the original; 0 for GB1. Applied before rbe/blacklist/dedup, independently per message (not serialized). */
	preDelayMs: number;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
	log: typeof console;
	isDebugEnabled: () => boolean;
	// NOT a port of flows.json node-for-node (there's no single change
	// node this corresponds to), but restoring a CAPABILITY the
	// maintainer confirmed the original had and this port had dropped
	// (2026-09-13: "in flows.json there was the option to log all
	// notification message received") -- a debug/log tap wired directly
	// off the mqtt-in node, ahead of rbe/blacklist/dedup/parsing, so it
	// captures literally every message that arrives on the wire
	// regardless of what happens to it afterward. Distinct from
	// consumer.ts's own "Decision" log (which only ever sees whatever
	// SUCCESSFULLY reaches processEntry, downstream of every ingest-side
	// filter below) -- a message this port blacklists, rbe-dedupes,
	// fails to parse, or wnm.id-dedupes today leaves NO trace in
	// consumer.ts's log, in Redis (writeDownloadJob/recordWait never
	// run for it), or in IngestStats beyond an aggregate counter -- this
	// is the only place such a message is ever individually
	// identifiable. NOT a port, so it follows the maintainer's own
	// level policy from scratch rather than any flows.json precedent
	// (2026-09-13: "info is the bare minimum ... to see what is working
	// as expected ... debug is to be enabled when investigation is
	// needed") -- logging every single message individually is
	// per-message investigation detail, not a sparse "is it working"
	// signal, so this is emitted at DEBUG, never info. Optional so
	// every existing hand-built IngestDeps in this file's own tests
	// keeps compiling without it.
	//
	// wnmId/dataId (2026-09-20, NOT a port): originally just
	// `{source, topic, bytes}` -- the maintainer, after living with this
	// file: "typically the content of wis2gc-received-*.debug.log is
	// useless." Correct -- a topic string never contains a data_id, so
	// the one log guaranteed to have a line for every message ever
	// received couldn't be grepped for a specific one. See
	// createIngestHandler's own call site for how the extraction is kept
	// free below `log.level: debug` despite firing on every message
	// unconditionally (this is the hottest of every call site this
	// tracing effort touches).
	receivedLog?: SourceLogger;
	// NOT a port -- added 2026-09-20, alongside consumer.ts's decisionLog
	// enrichment (see that file's ConsumerDeps.decisionLog doc comment for
	// the same rationale): the maintainer, after the loop-blocking and
	// hard-cap fixes above, reported STILL seeing some data_id missing
	// ("Probably a bit less than before but still...") and asked for a
	// debug build with logging well beyond the current debug level --
	// "LOGS LOGS LOGS" -- specifically to grep a data_id (reported missing
	// by the maintainer's own separate "origin messages" tool) end-to-end
	// through this role's logs.
	//
	// receivedLog (above) already answers "did this topic arrive on the
	// wire at all" -- but it fires BEFORE any parsing, by design (as close
	// to "the message arrived" as this handler ever gets, ahead of every
	// filter), so it can never carry a data_id. This is the missing half:
	// WHY a specific, already-arrived message never made it onto the raw
	// stream for consumer.ts to see. Every one of this handler's five
	// outcomes (unchanged/rbe, blacklisted, malformed, duplicate wnm.id,
	// ingested) logs here, carrying wnm.id/data_id whenever the payload was
	// parseable enough to extract them (see extractIdsForLogging below --
	// best-effort, never throws, never affects the real filter decisions,
	// which still operate on raw strings/already-parsed wnm exactly as
	// before).
	//
	// Fires for all five outcomes, gated by a SINGLE switch --
	// `global.log.level: debug` (or a per-role override), same as every
	// other logger here -- not by deps.isDebugEnabled() (the older,
	// separate per-role runtime toggle -- see debug.ts). Two earlier
	// designs were tried and rejected here:
	//
	// 1. Gate the whole thing behind deps.isDebugEnabled(), requiring a
	// SEPARATE POST /set call on top of `log.level: debug` to get the full
	// trace. The maintainer pushed back ("I'd prefer that debug in
	// log-level is enough to enable all debug. Don't get why this...") --
	// rightly so, since every other logger here already worked off
	// `log.level` alone.
	// 2. Just call this unconditionally, same as duplicate/ingested/
	// malformed below, and let SourceLogger's own level check decide
	// whether to WRITE. This is correct for THOSE three outcomes (the
	// message is already parsed regardless, for the real pipeline's own
	// sake -- logging it costs nothing extra). It is NOT correct for
	// unchanged/blacklisted specifically: they run BEFORE this handler's
	// own JSON.parse, so logging them needs an EXTRA parse of a payload
	// that's about to be discarded regardless -- calling this
	// unconditionally would pay that parse cost on every single
	// rbe-suppressed or blacklisted message, at ANY log level, even
	// 'info' -- a real, always-on cost with no way to avoid it, on
	// exactly the kind of high-volume, easy-to-overlook hot path that
	// caused the 2026-09-20 production incident above.
	//
	// The actual fix: SourceLogger.debugEnabled() (logging/logger.ts) is a
	// cheap, real check against the CONFIGURED level -- so the extra parse
	// for unchanged/blacklisted only happens when `filterLog.debugEnabled()`
	// is true, i.e. `global.log.level: debug` (or a per-role override) is
	// actually set. At any other level, it's one boolean check, nothing
	// more -- safe to ship and run everywhere, not just a special debug
	// build. See each call site (`filterLogWantsIt`) below.
	//
	// `deps.isDebugEnabled()` remains relevant only for the separate
	// plain-text stdout lines below, which just duplicate this same
	// information unstructured, and independently ALSO triggers the extra
	// parse when it's on (so flipping that legacy toggle still works
	// exactly as it always did) -- ignore it entirely if all you want is
	// the traced file logs via `log.level: debug`.
	//
	// Named "Filter" -- the ingest-side counterpart to consumer.ts's own
	// "Decision" log: this is "what did THIS wire message's ingest stage do
	// with it", not "what did the parsed, classified stream entry get
	// decided" (that's decisionLog's job, downstream). Emitted at DEBUG,
	// same level policy as every other non-ported addition here. Optional
	// so every existing hand-built IngestDeps in this file's own tests
	// keeps compiling without it.
	//
	// wnm, not just wnmId/dataId (2026-09-20, same day, NOT a port): this
	// log originally carried only the two extracted id fields above --
	// right after living with the equally-minimal receivedLog fix for all
	// of ten minutes, the maintainer pushed back on the whole approach:
	// "What should be logged is the WNM (probably full content) after
	// deduplication. Not that 'extract'...". Fair -- two bare id strings
	// can confirm THAT a message existed, but not diagnose WHY it was
	// treated the way it was (a malformed WNM missing an expected field, a
	// legitimately-different message wrongly colliding on wnm.id, etc.);
	// only the full notification answers that.
	//
	// The "after deduplication" half of that feedback is what makes this
	// free rather than a repeat of the unchanged/blacklisted cost problem
	// above: by the time the 'duplicate' or 'ingested' outcome is decided,
	// this handler has ALREADY parsed the payload into `wnm` for its own
	// real control flow (the wnm.id dedup check itself needs it) -- so
	// passing that same in-memory object to filterLog.debug() below adds
	// no extra parse, no extra work, at any log level. It costs nothing
	// until debug is actually admitted and the sink turns it into bytes on
	// disk (levelAdmits, in createSourceLogger's emit -- see
	// logging/logger.ts), same as everything else here.
	//
	// unchanged/blacklisted/malformed also switched from returning just
	// {wnmId, dataId} to the full parsed object where one exists (see
	// parseForLogging below, renamed from extractIdsForLogging) -- for
	// unchanged/blacklisted this piggybacks on the SAME debugEnabled()-
	// gated parse that already existed for the id fields, so it's the same
	// cost as before, just fuller content once paid for; malformed already
	// parses unconditionally today (a rare, error-path call), and its
	// result is now attached too, when JSON.parse got far enough to
	// produce an object at all (a fully unparseable payload still has no
	// `wnm` to attach -- there is nothing to log beyond the raw error).
	filterLog?: SourceLogger;
}

export interface IngestStats {
	received: number;
	unchanged: number;
	blacklisted: number;
	duplicate: number;
	malformed: number;
	ingested: number;
}

export function createIngestStats(): IngestStats {
	return { received: 0, unchanged: 0, blacklisted: 0, duplicate: 0, malformed: 0, ingested: 0 };
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Returns the per-message handler to wire to an MqttLike's onMessage
// for one broker connection. stats is mutated in place so callers
// (and tests) can observe counts without needing to intercept logs.
//
// rbe (Node-RED's built-in "report by exception", septopics:true) is
// folded in here as an in-memory Map<topic, lastRawPayload>: the first
// message on a topic always passes; a later message on the same topic
// with byte-identical payload is dropped, exactly like the original's
// rbe node ahead of the blacklist step. The map lives in this
// closure, one per connection (matching the original's one rbe node
// per mqtt-in), and is keyed by the RAW (unstripped) topic, since rbe
// runs before the replay-prefix stripping Black & GRep does.
export function createIngestHandler(deps: IngestDeps, stats: IngestStats): (topic: string, payload: Buffer) => Promise<void> {
	const lastPayloadByTopic = new Map<string, string>();

	// Best-effort parse, purely for filterLog's sake -- never throws, and
	// its result is never fed into any control-flow decision (the real
	// pipeline keeps working exactly as before, off raw strings/the
	// separately-parsed `wnm` below). Renamed from extractIdsForLogging
	// (2026-09-20, same day, NOT a port): it used to return only the two
	// extracted id fields; the maintainer, immediately after seeing that
	// pattern applied to receivedLog too, pushed back on the whole idea --
	// "What should be logged is the WNM (probably full content) after
	// deduplication. Not that 'extract'...". Now returns the parsed object
	// itself (wnmId/dataId are pulled from it at each call site below,
	// same as they always were straight off `wnm` for the ingested/
	// duplicate outcomes) -- callers attach the full `wnm` to their log
	// line rather than just its id and data_id. Returns an empty object
	// when the payload isn't even valid JSON -- there's nothing to attach
	// in that case, and filterLog's 'malformed' call site already reports
	// the parse error itself.
	const parseForLogging = (raw: string): { wnm?: Partial<Wnm> } => {
		try {
			return { wnm: JSON.parse(raw) as Partial<Wnm> };
		} catch {
			return {};
		}
	};

	return async (topic: string, payload: Buffer) => {
		// `raw` hoisted up here (2026-09-20, NOT a port) -- it used to be
		// computed further down, after the pre-delay/stats bump, purely
		// because nothing above it needed it yet. Buffer#toString('utf8')
		// itself costs nothing extra either way (this handler always did
		// it, unconditionally, for the real pipeline below) -- the ONLY
		// reason to have it in hand this early is receivedLog next.
		const raw = payload.toString('utf8');

		// Unconditional CALL, before EVEN the GB2 fixed pre-delay -- as
		// close to "the message arrived" as this handler ever gets, and
		// ahead of every filter below (rbe/blacklist/parse/dedup) that can
		// otherwise make a message vanish without individual trace. See
		// this field's own doc comment (IngestDeps.receivedLog) for why.
		//
		// wnmId/dataId (2026-09-20, NOT a port -- the maintainer: "the
		// content of wis2gc-received-*.debug.log is typically useless").
		// Fair: `{source, topic, bytes}` alone can't be grepped for a
		// specific missing data_id at all -- data_id lives in the JSON
		// BODY, never the topic string, so the one file guaranteed to have
		// a line for every single message that ever arrived was also the
		// one file useless for the actual investigation this whole effort
		// is for. Fixed the same way as filterLog's unchanged/blacklisted
		// outcomes just above: the extraction only runs when
		// receivedLog.debugEnabled() says `debug` is actually the
		// configured level -- this call site fires on EVERY message
		// received, unconditionally, at any log level, so an unconditional
		// JSON.parse here would be an even hotter path than the one that
		// caused the original incident. `?? true` for a hand-built test
		// fake with no debugEnabled() at all -- same fallback policy as
		// filterLog's.
		if (deps.receivedLog) {
			const receivedLogWantsIt = deps.receivedLog.debugEnabled?.() ?? true;
			const { wnm: receivedWnm } = receivedLogWantsIt ? parseForLogging(raw) : {};
			const wnmId = typeof receivedWnm?.id === 'string' ? receivedWnm.id : undefined;
			const dataId = typeof receivedWnm?.properties?.data_id === 'string' ? receivedWnm.properties.data_id : undefined;
			deps.receivedLog.debug({ source: deps.sourceLabel, topic, bytes: payload.length, wnmId, dataId });
		}
		if (deps.preDelayMs > 0) await deps.sleep(deps.preDelayMs);

		stats.received++;

		const previous = lastPayloadByTopic.get(topic);
		lastPayloadByTopic.set(topic, raw);
		if (previous === raw) {
			stats.unchanged++;
			// `global.log.level: debug` (or a per-role override) is the ONE
			// switch that governs every structured log this file emits --
			// see IngestDeps.filterLog's doc comment. That's what
			// filterLog.debugEnabled() reflects (SourceLogger.debugEnabled's
			// own doc comment, logging/logger.ts): a cheap, real check
			// against the ACTUAL configured level, so the extra JSON.parse
			// this needs (unchanged/blacklisted run before this handler's
			// own parse) is only paid when something would actually consume
			// it -- unlike the first cut of this feature, which paid it
			// unconditionally regardless of log level. `?? true` if filterLog
			// doesn't implement debugEnabled() at all (a hand-built fake, in
			// tests) -- assume yes rather than silently going quiet.
			// isDebugEnabled() (the separate, older per-role runtime toggle)
			// still independently gates the plain stdout console.log line
			// below, which duplicates this same information as unstructured
			// text -- not needed to get the full traced picture.
			const filterLogWantsIt = deps.filterLog !== undefined && (deps.filterLog.debugEnabled?.() ?? true);
			if (deps.isDebugEnabled() || filterLogWantsIt) {
				const { wnm: parsedWnm } = parseForLogging(raw);
				const wnmId = typeof parsedWnm?.id === 'string' ? parsedWnm.id : undefined;
				const dataId = typeof parsedWnm?.properties?.data_id === 'string' ? parsedWnm.properties.data_id : undefined;
				if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] unchanged payload (rbe), dropping: ${topic}${dataId ? ` (data_id ${dataId})` : ''}`);
				if (filterLogWantsIt) deps.filterLog!.debug({ source: deps.sourceLabel, topic, wnmId, dataId, outcome: 'unchanged', wnm: parsedWnm });
			}
			return;
		}

		const normalisedTopic = stripReplayPrefix(topic);
		if (isBlacklisted(normalisedTopic, deps.blacklist)) {
			stats.blacklisted++;
			const filterLogWantsIt = deps.filterLog !== undefined && (deps.filterLog.debugEnabled?.() ?? true);
			if (deps.isDebugEnabled() || filterLogWantsIt) {
				const { wnm: parsedWnm } = parseForLogging(raw);
				const wnmId = typeof parsedWnm?.id === 'string' ? parsedWnm.id : undefined;
				const dataId = typeof parsedWnm?.properties?.data_id === 'string' ? parsedWnm.properties.data_id : undefined;
				if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] blacklisted, dropping: ${topic}${dataId ? ` (data_id ${dataId})` : ''}`);
				if (filterLogWantsIt) deps.filterLog!.debug({ source: deps.sourceLabel, topic, wnmId, dataId, outcome: 'blacklisted', wnm: parsedWnm });
			}
			return;
		}

		let wnm: Wnm;
		try {
			wnm = JSON.parse(raw) as Wnm;
			if (typeof wnm?.id !== 'string' || !wnm.id) throw new Error('missing wnm.id');
		} catch (err) {
			stats.malformed++;
			const message = err instanceof Error ? err.message : String(err);
			deps.log.error(`[${deps.sourceLabel}] malformed WNM on ${topic}: ${message}`);
			// Best-effort -- JSON.parse may have actually succeeded before the
			// "missing wnm.id" throw fired just above, so there can still be a
			// full object (and a data_id within it) worth surfacing even
			// though the message itself is unusable (no id to dedup on).
			// parseForLogging does its own isolated parse rather than reaching
			// for the (possibly unassigned) `wnm` above; when even THAT parse
			// fails, parsedWnm is undefined and only the raw error is logged --
			// there's nothing else to attach.
			const { wnm: parsedWnm } = parseForLogging(raw);
			const wnmId = typeof parsedWnm?.id === 'string' ? parsedWnm.id : undefined;
			const dataId = typeof parsedWnm?.properties?.data_id === 'string' ? parsedWnm.properties.data_id : undefined;
			deps.filterLog?.debug({ source: deps.sourceLabel, topic, wnmId, dataId, outcome: 'malformed', error: message, wnm: parsedWnm });
			return;
		}

		const dataId = typeof wnm.properties?.data_id === 'string' ? wnm.properties.data_id : undefined;

		const isNew = await deps.store.claimMessageId(wnm.id, MESSAGE_ID_DEDUP_TTL_SECONDS);
		if (!isNew) {
			stats.duplicate++;
			if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] duplicate wnm.id ${wnm.id}, dropping: ${topic}`);
			// wnm, not just wnmId/dataId (2026-09-20, same day, NOT a port):
			// see IngestDeps.filterLog's doc comment -- `wnm` is already
			// sitting in scope from this handler's own real parse above (the
			// dedup check itself needs it), so attaching the whole thing here
			// costs nothing beyond what this call already paid.
			deps.filterLog?.debug({ source: deps.sourceLabel, topic, wnmId: wnm.id, dataId, outcome: 'duplicate', wnm });
			return;
		}

		await deps.store.appendRawMessage(deps.queue, topic, raw, deps.now());
		stats.ingested++;
		if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] ingested ${wnm.id}: ${topic}`);
		// Same rationale as the 'duplicate' outcome just above -- `wnm` is
		// the exact object this handler already parsed and is about to hand
		// to appendRawMessage; logging it here is the "after deduplication"
		// full-content record the maintainer asked for, at zero extra cost.
		deps.filterLog?.debug({ source: deps.sourceLabel, topic, wnmId: wnm.id, dataId, outcome: 'ingested', wnm });
	};
}
