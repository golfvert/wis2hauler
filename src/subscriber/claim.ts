// The content-dedup claim decision: given whether this content is
// already fully cached (EXISTS on downloaderCompleteKey) and whether
// this message won the SETNX race on downloaderClaimKey, decide what
// to do. Ported from the Node-RED "Complete ?" + "Action ?" switch
// nodes (Subscriber tab) — deliberately kept as a pure function over
// pre-fetched Redis results (not doing the Redis calls itself) so the
// decision table is unit-testable without a live Redis, and so the
// actual EXISTS/SETNX I/O — which belongs to the pipeline that wires
// this role up to a real Redis client — stays separate from the
// decision logic.
//
// "Action ?"'s three rules are evaluated with checkAll:false in the
// original (first match wins, like if/else-if/else) — this mirrors
// that with an ordinary if-chain, which is the same thing.

export type ClaimAction =
	| { kind: 'already-complete' } // EXISTS found this downloader_id already fully cached — nothing to do
	| { kind: 'publish-only' } // claimed the race, global-cache mode is on, and nocache is set — republish + emit a monitoring event, no download
	| { kind: 'download' } // claimed the race, not (global-cache mode AND nocache) — queue a real download (the original's plain "1st")
	| { kind: 'wait' } // lost the race (someone else already claimed it) and nocache is NOT set — record a "wait" entry alongside the winner's job
	| { kind: 'drop' }; // lost the race and nocache IS set — nothing this copy needs to do

export interface ClaimInputs {
	/** EXISTS on redis-keys.ts's downloaderCompleteKey(downloaderId). */
	alreadyComplete: boolean;
	/** true if this message's SETNX on downloaderClaimKey(downloaderId) returned "OK"; false if it returned null (already claimed). */
	claimed: boolean;
	nocache: boolean;
	/** global.global-cache from the static config (see schema.ts's GlobalSection). */
	globalCacheMode: boolean;
}

export function decideClaimAction(input: ClaimInputs): ClaimAction {
	if (input.alreadyComplete) return { kind: 'already-complete' };

	if (input.claimed) {
		return input.globalCacheMode && input.nocache ? { kind: 'publish-only' } : { kind: 'download' };
	}

	return input.nocache ? { kind: 'drop' } : { kind: 'wait' };
}
