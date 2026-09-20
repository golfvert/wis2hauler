// Reorders a WNM's links (canonical/update first) and classifies an
// incoming message by topic so the pipeline knows whether — and how
// long — to delay it before the content-dedup claim race (see
// dedup.ts). Ported from the Node-RED "Order links" function node
// (Subscriber tab); the staggering/weighting mechanism itself has been
// redesigned since (2026-09-20 — see below), so this is no longer a
// literal port of that node's delay logic, only of reorderLinks() and
// the origin/cache topic split.
//
// The staggering exists because the same content can arrive via
// multiple paths (the true origin, plus zero or more Global Cache
// repeaters) and, rather than coordinate explicitly, each candidate
// independently draws a random delay before attempting the SETNX claim
// in dedup.ts — so in the common case the "best" copy (by weight) wins
// the claim and everything else naturally falls into the "someone
// already claimed this" branch.
//
// 2026-09-20 (the maintainer): replaced the old static
// priority-global-cache ordered list (position-indexed stagger table,
// CACHE_STAGGER_SECONDS) with a weighted scheme. The old mechanism
// always let origin and the highest-priority Global Cache race
// unstaggered, which meant a handful of very active sources' origin
// servers (and any GC that happens to be first in the list) took the
// full, undivided peak of every subscriber's claim attempts — and
// aria2's per-source connection limits mean piling every replica's
// downloads onto the same server produces outright errors (HTTP 502),
// not just slowness. Weighting spreads the *expected* share of
// downloads across sources roughly proportional to configured weight,
// with no static "winner", and generalizes the old "unprioritized cache
// races origin" default via resolveWeight()'s two rules below.
import type { Wnm } from '../wis2/wnm.ts';

export function reorderLinks(wnm: Wnm): Wnm {
	const priority = wnm.links.filter((l) => l.rel === 'canonical' || l.rel === 'update');
	const rest = wnm.links.filter((l) => l.rel !== 'canonical' && l.rel !== 'update');
	return { ...wnm, links: [...priority, ...rest] };
}

export type TopicClassification =
	| { kind: 'origin'; weight: number } // a true origin/a/wis2/... topic
	| { kind: 'cache'; weight: number } // cache/a/wis2/... from a recognized global-cache source
	| { kind: 'ignore'; reason: string }; // neither pattern matched, a cache message with no/unrecognized global-cache label, or a source resolved to weight 0 — drop
// `reason` on the 'ignore' variant -- added 2026-09-20 at the maintainer's
// request while chasing still-missing data_id after the loop-blocking and
// hard-cap fixes ("I still see some data_id missing... I would like a
// debug version... LOGS LOGS LOGS"): an 'ignore' classification used to
// carry nothing beyond its kind, so consumer.ts's processEntry (see that
// file's own decisionLog doc comment) had no way to log WHY a given
// message never even entered the delay/claim race -- the single most
// common way a data_id can go missing without a trace anywhere. Every
// call site below now states its own reason inline, so classifyTopic
// remains the one place that decision is made.

// The two default rules for subscriber['weight-sources'] (a config map
// from source key -- "origin", or the full raw wnm.properties['global-cache']
// string, e.g. "de-dwd-global-cache" -- to a non-negative weight):
//
//   1. weightSources itself is undefined (the field is entirely absent
//      from config) -- every source gets weight 1. Fully permissive,
//      matching the zero-config behavior before this map existed (origin
//      and every cache source raced on equal footing).
//   2. weightSources IS present (even with just one entry) -- any source
//      not explicitly listed as a key, INCLUDING "origin" if omitted,
//      gets weight 0 (never used). This is a deliberate behavior change
//      from the old priority-global-cache list, which never gated
//      origin's eligibility at all -- configuring weight-sources without
//      an explicit origin: entry silently disables all direct-from-origin
//      downloads for every centre.
export function resolveWeight(key: string, weightSources: ReadonlyMap<string, number> | undefined): number {
	if (!weightSources) return 1;
	return weightSources.get(key) ?? 0;
}

// topic is the raw MQTT topic as received — deliberately checked with
// substring matching (not a prefix/startsWith check), matching the
// original's `msg.topic.includes(...)` exactly: a replayed message's
// topic is wrapped as "replay/a/wis2/<grep-centre>/<uuid>/<real-topic>",
// and the substring check is what lets origin/cache classification
// keep working *through* that wrapper without stripping it first (contrast
// with topic-match.ts's stripReplayPrefix, used where an exact-prefix
// check is needed instead, e.g. blacklist/override matching).
export function classifyTopic(topic: string, wnm: Wnm, weightSources: ReadonlyMap<string, number> | undefined): TopicClassification {
	if (topic.includes('origin/a/wis2')) {
		const weight = resolveWeight('origin', weightSources);
		if (weight > 0) return { kind: 'origin', weight };
		return { kind: 'ignore', reason: 'origin resolved to weight 0 (missing from weight-sources, or explicitly weighted 0)' };
	}

	if (topic.includes('cache/a/wis2')) {
		const globalCache = wnm.properties['global-cache'];
		if (typeof globalCache !== 'string') {
			return { kind: 'ignore', reason: 'cache topic has no (string) global-cache property to classify by' };
		}

		const weight = resolveWeight(globalCache, weightSources);
		if (weight > 0) return { kind: 'cache', weight };
		return { kind: 'ignore', reason: `source '${globalCache}' resolved to weight 0 (missing from weight-sources, or explicitly weighted 0)` };
	}

	return { kind: 'ignore', reason: 'topic matches neither origin/a/wis2 nor cache/a/wis2' };
}

// Seconds to wait before this classification enters the claim race.
// Each candidate independently draws an exponentially-distributed delay
// with rate proportional to its weight (-ln(U) * scale/weight, U ~
// Uniform(0,1)): if N independent candidates for the same content each
// do this, the probability that candidate i's delay elapses first (i.e.
// wins the claim race) is exactly weight_i / sum(weights), with no
// cross-candidate coordination needed -- fits this pipeline's existing
// per-message, no-shared-visibility architecture.
//
// This is an APPROXIMATION, not an exact guarantee: the math above
// assumes every candidate's clock starts at the same instant, but real
// messages don't -- origin structurally arrives first in wall-clock time
// (a Global Cache can only republish after receiving from origin). The
// approximation holds well when weightDelaySeconds is comfortably larger
// than the typical real arrival-time skew between origin and its
// mirrors, and holds less precisely otherwise.
//
// `maxDelaySeconds` (subscriber['weight-delay-max-seconds'], see
// schema.ts) is a HARD CAP, added 2026-09-20 after a production incident
// (see consumer.ts's runConsumerLoop doc comment for the full story): an
// exponential distribution has NO natural upper bound, and a low enough
// weight relative to weightDelaySeconds can produce a mean delay of tens
// of seconds with a long right tail -- unacceptable when the maintainer's
// operational requirement is "a download must complete, including
// retries and transfer time, within 10 minutes", which needs the initial
// wait itself tightly bounded. `Math.min(raw, maxDelaySeconds)` is a
// plain truncation, not a re-normalization of the exponential -- it does
// NOT preserve the weight_i/sum(weights) win-probability property in the
// (rare, by design) case where a draw actually hits the cap, since every
// candidate that gets clipped to the same `maxDelaySeconds` value then
// effectively ties (broken by whichever's sleep timer fires first in
// real wall-clock terms, i.e. back to arrival order for that slice of
// outcomes). This is an accepted, deliberate trade-off: the cap exists
// specifically to bound the worst case, and by design should trigger for
// only a small percentage of draws -- see the percentile math below for
// how to choose weightDelaySeconds so that holds for your own weights.
//
// CHOOSING weightDelaySeconds AND maxDelaySeconds together: for a given
// weight, the resulting delay is exponential with mean
// `mu = weightDelaySeconds / weight`. Useful quantile/tail facts for an
// exponential with mean `mu`:
//   - P(delay > x)      = e^(-x / mu)
//   - median            = mu * ln(2)   ≈ 0.693 * mu
//   - p-th percentile   = -mu * ln(1 - p)   (e.g. p=0.9 -> mu * ln(10) ≈ 2.3026 * mu)
// To target a specific percentile bound for your WORST (lowest-weight)
// source -- e.g. "the 90th percentile of de-dwd-global-cache's wait
// should be <= 60s" -- solve for mu first (`mu = target / ln(1/(1-p))`,
// e.g. `60 / ln(10) ≈ 26.06s` for p=0.9), then
// `weightDelaySeconds = mu * weight_min`. Every OTHER (higher-weighted)
// source then automatically gets a smaller mu (faster), since mu is
// inversely proportional to weight. Pick maxDelaySeconds comfortably
// above that same target percentile (never below it, or the cap would
// itself distort the percentile you just solved for) and check
// `e^(-maxDelaySeconds / mu)` for the worst source is small -- that's the
// fraction of draws that will actually hit the cap. See
// docs/configuration-and-roles.md for a fully worked example.
//
// `random` is injectable (defaults to Math.random via the caller) for
// deterministic tests, following this codebase's established DI
// convention for nondeterministic primitives (e.g. aria-start.ts's
// randomStreamSuffix).
//
// classifyTopic never returns a classification with weight <= 0 (weight
// 0 resolves to 'ignore' instead), so this function should never
// actually be called with a non-positive weight in practice -- but it
// still guards against it explicitly (returning 0, i.e. no delay) rather
// than risking a divide-by-zero/Infinity sleep if that invariant is ever
// violated by a future caller.
export function computeDelaySeconds(classification: TopicClassification, weightDelaySeconds: number, maxDelaySeconds: number, random: () => number): number {
	if (classification.kind === 'ignore') return 0;
	const { weight } = classification;
	if (weight <= 0) return 0;
	const raw = -Math.log(random()) * (weightDelaySeconds / weight);
	return Math.min(raw, maxDelaySeconds);
}
