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
	receivedLog?: SourceLogger;
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

	return async (topic: string, payload: Buffer) => {
		// Unconditional, before EVEN the GB2 fixed pre-delay -- as close
		// to "the message arrived" as this handler ever gets, and ahead
		// of every filter below (rbe/blacklist/parse/dedup) that can
		// otherwise make a message vanish without individual trace. See
		// this field's own doc comment (IngestDeps.receivedLog) for why.
		deps.receivedLog?.debug({ source: deps.sourceLabel, topic, bytes: payload.length });
		if (deps.preDelayMs > 0) await deps.sleep(deps.preDelayMs);

		stats.received++;
		const raw = payload.toString('utf8');

		const previous = lastPayloadByTopic.get(topic);
		lastPayloadByTopic.set(topic, raw);
		if (previous === raw) {
			stats.unchanged++;
			if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] unchanged payload (rbe), dropping: ${topic}`);
			return;
		}

		const normalisedTopic = stripReplayPrefix(topic);
		if (isBlacklisted(normalisedTopic, deps.blacklist)) {
			stats.blacklisted++;
			if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] blacklisted, dropping: ${topic}`);
			return;
		}

		let wnm: Wnm;
		try {
			wnm = JSON.parse(raw) as Wnm;
			if (typeof wnm?.id !== 'string' || !wnm.id) throw new Error('missing wnm.id');
		} catch (err) {
			stats.malformed++;
			deps.log.error(`[${deps.sourceLabel}] malformed WNM on ${topic}: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		const isNew = await deps.store.claimMessageId(wnm.id, MESSAGE_ID_DEDUP_TTL_SECONDS);
		if (!isNew) {
			stats.duplicate++;
			if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] duplicate wnm.id ${wnm.id}, dropping: ${topic}`);
			return;
		}

		await deps.store.appendRawMessage(deps.queue, topic, raw, deps.now());
		stats.ingested++;
		if (deps.isDebugEnabled()) deps.log.log(`[${deps.sourceLabel}] ingested ${wnm.id}: ${topic}`);
	};
}
