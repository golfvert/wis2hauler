// Origin-topic data_id-reuse (duplicate) detection.
//
// NOT a port of anything in flows.json -- flows.json's Subscriber tab
// has no equivalent step at all, and content-id.ts's computeDownloaderId
// (the actual dedup key the original DOES build, ported field-for-field
// from the "downloader_id" change node) is deliberately left untouched
// by this file: that key still folds pubtime in unconditionally, which
// is a real, independently-confirmed bug (see below), but the maintainer
// asked for this to be a separate, earlier check rather than a change to
// that key's formula.
//
// Added 2026-09-17 after the maintainer noticed, via a *different* tool
// they maintain ("Sensor Global Cache" / SCGC, a Node-RED flow that
// compares Global Cache performance across the WIS2 federation), that a
// real origin (ca-eccc-msc) republished the same data_id at the same
// pubtime with rel=canonical both times -- a spec violation (WIS2
// requires rel=update for any data_id reused after its first
// publication), which SCGC's own dedup step failed to catch because its
// "Prepare" node folds pubtime into the SAME Redis key it uses to look
// up prior history, making every "duplicate" look like a brand-new
// data_id. The maintainer confirmed hauler's SUBSCRIBER has the exact
// same flaw (computeDownloaderId does the same unconditional pubtime
// fold) and, after the maintainer already fixed SCGC's own flow (node
// 3100f7aa144dfebe: a new `dataid_raw` field, used ONLY to key the
// pubtime-history hash, leaving every downstream decision node
// untouched), asked for hauler's SUBSCRIBER to gain the equivalent
// check, following the SAME algorithm SCGC's (already-validated)
// downstream nodes implement -- not the simpler `data_id:hash` shortcut
// this port first proposed, which the maintainer explicitly rejected:
// "Using data_id:hash to check is still risky. If the file is
// effectively updated (so new hash) the rel MUST be update. If it is
// also canonical then, it should be ignored. So, a tight more clever
// than just data_id:hash, I'm afraid."
//
// The algorithm (reverse-engineered directly from SCGC's flows.json --
// nodes d5bb69f4d4f8c1b4 "Empty ?", da9042e45b74ed1c "Keys",
// 47515d621ebc39f1 "Pubtime up ?", a85bf3a7164bde23 "Update ?"):
//   - No prior pubtime recorded for this (origin centre, data_id) at
//     all -> NEW. Always accepted, whatever rel says.
//   - A prior pubtime IS recorded, and the incoming pubtime is not
//     STRICTLY GREATER than every one of them -> DUPLICATE, whatever
//     rel says (a same-or-older republish is never legitimate new
//     content).
//   - The incoming pubtime IS strictly greater than every prior one:
//       - rel includes "update" -> UPDATE (legitimate new content).
//       - rel does not include "update" (i.e. still just canonical)
//         -> DUPLICATE: a newer pubtime for a data_id already seen
//         requires rel=update per the WIS2 spec; a producer that
//         bumps pubtime without setting it is exactly the ca-eccc-msc
//         bug this check exists to catch.
//
// Scope, per the maintainer's explicit clarification when asked ("It is
// mostly on origin. It is normal to received multiple identical data_id
// and same pubtime coming from the various GC. So these are not
// duplicates! However, if a GC is pushing multiple times the same
// data_id, same pubtime and no rel=update this it is a duplicate. So,
// subtle."): this same decideLineage/hasUpdateRel logic is applied
// TWICE in consumer.ts, against two SEPARATE histories:
//
//   1. origin/a/wis2/... traffic (classifyTopic's `{kind: 'origin'}`),
//      keyed by (origin centre, data_id) -- matching SCGC's own scope
//      (it subscribes literally "origin/*"). This catches an ORIGIN
//      reusing a data_id without rel=update.
//
//   2. cache/a/wis2/... traffic (`{kind: 'cache'}` or
//      `{kind: 'cache-unprioritized'}`), keyed by (the message's own
//      `global-cache` label, data_id) -- added 2026-09-17 at the
//      maintainer's explicit follow-up request ("if a GC is pushing
//      multiple times the same data_id, same pubtime and no rel=update
//      this it is a duplicate" / "Because if a Global Cache goes crazy,
//      it must be controlled..."). This catches a MISBEHAVING Global
//      Cache repeating ITS OWN publication of a data_id without
//      rel=update.
//
// Critically, these two histories are NEVER shared or merged: several
// DIFFERENT Global Caches legitimately relaying the SAME origin publish
// (same data_id, same pubtime, same rel) is normal fan-out, not a
// duplicate -- each GC's cache-topic history is tracked under its own
// key (subscriberGlobalCacheLineageKey), so GC A's publish never counts
// as "prior history" against GC B's identical relay. That existing,
// correct fan-out handling is untouched -- only a GC repeating against
// its OWN history is now caught. See consumer.ts's processEntry for
// where both checks are wired in.
import type { Wnm } from '../wis2/wnm.ts';

// Matches infoGranuleKey's own 86400s (24h) EXPIRE precedent (see
// redis-keys.ts) -- there's no reason for a lineage record to outlive
// one day of federation traffic for a given data_id.
export const LINEAGE_TTL_SECONDS = 86400;

export function hasUpdateRel(wnm: Wnm): boolean {
	return wnm.links.some((l) => l.rel === 'update');
}

export type LineageDecision =
	| { kind: 'new' }
	| { kind: 'update' }
	| { kind: 'duplicate'; reason: string };

// pubtime is an ISO 8601 string (fixed-width, zero-padded, UTC, per
// wnm.ts's WnmProperties.pubtime) -- plain string comparison sorts it
// correctly, same as SCGC's own jsonata `$value < pubtime` check.
export function decideLineage(pubtime: string, isUpdate: boolean, knownPubtimes: readonly string[]): LineageDecision {
	if (knownPubtimes.length === 0) return { kind: 'new' };

	const isNewerThanEveryKnownPubtime = knownPubtimes.every((known) => known < pubtime);
	if (!isNewerThanEveryKnownPubtime) {
		return { kind: 'duplicate', reason: 'pubtime is not newer than a previously seen publish for this data_id' };
	}
	if (!isUpdate) {
		return { kind: 'duplicate', reason: 'newer pubtime but rel is not "update" -- data_id reuse requires rel=update per the WIS2 spec' };
	}
	return { kind: 'update' };
}
