// The Downloader retry state machine. Ported field-for-field from the
// Node-RED "Next" function node (Downloader tab, id 10817f441ec6fc4d) --
// given the CURRENT flat HGETALL array of a downloader_id hash (the
// same record Subscriber's writeDownloadJob/recordWait wrote and every
// retry attempt since has mutated), decide whether there is another
// href worth trying.
//
// This function does NOT touch Redis itself -- same "pure decision,
// I/O happens elsewhere" split as claim.ts. The actual atomic
// mutation happens in lua.ts's LUA_RETRY script (called from
// run.ts/retry.ts's orchestration), re-checking the current state
// under a fresh HGET rather than trusting this snapshot, since another
// attempt could have raced ahead between the HGETALL that produced
// `hashArray` and the EVAL that acts on its conclusions.
//
// The hash record shape (set by Subscriber's writeDownloadJob/
// recordWait, and mutated in place by LUA_COMPLETE/LUA_RETRY): for
// every href the message has ever been queued under, a FIELD NAMED
// AFTER THE HREF holds its status ('queue' | 'wait' | 'complete' |
// 'error'), and a sibling field "src:"+href holds that href's source
// label. Plus a shared "attempt" counter field. This function reads
// that flat array exactly the way the original does: by scanning
// every element (not by parsing it into an object first), because the
// original's `arr[i-1]` check only means "the field name for this
// value" by virtue of the array's strict field,value,field,value
// alternation -- ported literally rather than "cleaned up" into a
// Map-based scan, so any edge case in a malformed/unusual record
// behaves identically to the original.

export type RetryDecision = 'RETRY_OK' | 'RETRY_NOK' | 'RETRY_NONEED';

export interface RetryResult {
	retry: RetryDecision;
	/** The (possibly mutated) flat array -- mutated locally exactly as the original mutates `arr`, but this function never writes it back to Redis itself. */
	payload: string[];
	extracted: string | null;
	/** Seconds to wait (the "Wait" delayv node's msg.delay) before applying the promotion -- only meaningful when retry === 'RETRY_OK'. */
	delaySeconds: number | undefined;
	promoteHref: string;
	promoteSource: string;
	newAttempt: string;
	errorHref: string;
	errorSource: string;
}

export function decideRetry(hashArray: readonly string[]): RetryResult {
	const arr = hashArray.slice(); // never mutate the caller's array, same as the original operating on its own local `msg.payload` copy

	let retry: RetryDecision = 'RETRY_NOK';
	let extracted: string | null = null;
	let delaySeconds: number | undefined;
	let promoteHref = '';
	let promoteSource = '';
	let newAttempt = '';
	let errorHref = '';
	let errorSource = '';

	const srcOf = (href: string): string => {
		const idx = arr.indexOf(`src:${href}`);
		return idx !== -1 && idx + 1 < arr.length ? arr[idx + 1]! : '';
	};

	let queueIndex = -1;
	let hasComplete = false;

	for (let i = 0; i < arr.length; i++) {
		const value = arr[i];
		if (typeof value !== 'string') continue;

		if (value === 'complete') {
			hasComplete = true;
		}

		if (value === 'queue') {
			const prev = arr[i - 1];
			if (i > 0 && typeof prev === 'string' && prev.startsWith('http')) {
				queueIndex = i;
			}
		} else if (value === 'wait') {
			const prev = arr[i - 1];
			if (i > 0 && typeof prev === 'string' && prev.startsWith('http')) {
				const waitHref = prev;

				let attemptValue = 0;
				const attemptIndex = arr.indexOf('attempt');
				if (attemptIndex !== -1 && attemptIndex + 1 < arr.length) {
					attemptValue = parseInt(arr[attemptIndex + 1]!, 10) || 0;
				}

				const hasErrorNoCache = arr.includes('error-nocache');
				const shouldRetry = attemptValue <= 6 && !hasErrorNoCache;

				if (shouldRetry) {
					retry = 'RETRY_OK';
					if (attemptIndex !== -1) {
						arr[attemptIndex + 1] = String(attemptValue + 1);
						delaySeconds = 5 * attemptValue;
					} else {
						arr.push('attempt', '1');
						delaySeconds = 5;
					}
					promoteHref = waitHref;
					promoteSource = srcOf(waitHref);
					newAttempt = String(attemptValue + 1);

					arr[i] = 'queue';
					extracted = waitHref;
				}

				break; // only the FIRST 'wait' href in the array is ever considered, whether or not it turned out retryable
			}
		}
	}

	if (hasComplete) {
		retry = 'RETRY_NONEED';
	}

	// Give up on the currently-active href only if nothing has completed
	// (a 'queue' entry racing against a sibling href that already
	// finished shouldn't be marked errored).
	if (queueIndex !== -1 && !hasComplete) {
		errorHref = arr[queueIndex - 1]!;
		errorSource = srcOf(arr[queueIndex - 1]!);
		arr[queueIndex] = 'error';
	}

	return { retry, payload: arr, extracted, delaySeconds, promoteHref, promoteSource, newAttempt, errorHref, errorSource };
}
