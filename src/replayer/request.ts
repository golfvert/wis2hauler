// The Replayer tab's "Replayer" function (956d90f4f52ba3bc, POST
// /replayer -- traced this session): validates the admin request body
// and, for a `replay` request, turns its from/to minutes-ago pair into
// the ISO datetime bounds ../replay.ts's triggerReplay() needs.
// Deliberately pure/synchronous -- no Redis, no fetch -- so it's
// testable on its own; ../run.ts wires the result to the actual
// RuntimeConfigStore write and triggerReplay() call.
export interface ReplayerPatch {
	globalReplay?: string;
	// ISO datetime bounds ready for triggerReplay(deps, from, to) --
	// `to` is the literal string '..' (open-ended) when the request's
	// `to` was 0 minutes ago, matching the "Replayer" function's own
	// `to === 0 ? '..' : ...` branch exactly.
	replayRange?: { from: string; to: string };
}

export interface ReplayerRequestResult {
	patch: ReplayerPatch;
	errors: string[];
}

/**
 * Body shape: {'global-replay'?: string, 'replay'?: {from: number, to: number}}
 * (minutes ago, both required together when `replay` is present). Mirrors
 * "Replayer"'s own checks: `from` must be > 0, `to` must be >= 0, and
 * `from` must be greater than `to` (a replay window can't run backwards).
 */
export function validateReplayerRequest(body: unknown, nowMs: number): ReplayerRequestResult {
	const errors: string[] = [];
	const patch: ReplayerPatch = {};

	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { patch, errors: ['Body must be a JSON object.'] };
	}
	const b = body as Record<string, unknown>;

	if ('global-replay' in b) {
		const v = b['global-replay'];
		if (typeof v !== 'string' || v.trim().length === 0) {
			errors.push('global-replay: must be a non-empty string.');
		} else {
			patch.globalReplay = v;
		}
	}

	if ('replay' in b) {
		const r = b.replay;
		if (typeof r !== 'object' || r === null || Array.isArray(r)) {
			errors.push('replay: must be an object with numeric from/to (minutes ago).');
		} else {
			const rr = r as Record<string, unknown>;
			const from = rr.from;
			const to = rr.to;
			if (typeof from !== 'number' || !(from > 0)) {
				errors.push('replay.from: must be a positive number (minutes ago).');
			} else if (typeof to !== 'number' || !(to >= 0)) {
				errors.push('replay.to: must be a non-negative number (minutes ago).');
			} else if (!(from > to)) {
				errors.push('replay.from must be greater than replay.to.');
			} else {
				const fromIso = new Date(nowMs - from * 60000).toISOString();
				const toIso = to === 0 ? '..' : new Date(nowMs - to * 60000).toISOString();
				patch.replayRange = { from: fromIso, to: toIso };
			}
		}
	}

	return { patch, errors };
}
