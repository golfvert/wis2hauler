// Per-role election poll, shared by Cleaner/Reporter/Replayer (see
// elect.ts's header note -- the three "Elect" function nodes are
// byte-for-byte identical apart from the ROLE constant, confirmed by
// reading all three verbatim this session; Cleaner's extra
// cleaning-needed/S3-awareness block is NOT part of this shared loop --
// it's appended by Cleaner's own onResult callback via
// computeCleaningNeeded, kept out of this file to avoid baking
// Cleaner-only behavior into the shared primitive).
//
// Polls the shared election hash every 10s, decides this role's
// primary/secondary status, hands the result (plus the full parsed
// worker map, for callers like Cleaner that need more than just the
// priority) to the caller via onResult, then reaps any stale entries
// it finds. Every role-carrying replica runs its own copy of this
// loop concurrently -- HDEL of an already-gone field is a no-op, so
// multiple replicas racing to reap the same stale worker is safe.
import type { ElectionStore } from './store.ts';
import { type ElectionPriority, type WorkersByName, decideElection, findStaleFields, parseElectionHash } from './elect.ts';

// The three "Elect" function nodes all run on a 10s repeat inject.
export const ELECTION_POLL_INTERVAL_MS = 10000;

export interface ElectorDeps {
	store: ElectionStore;
	role: string;
	uuid: string;
	onResult: (priority: ElectionPriority, workers: WorkersByName) => void;
	warn: (message: string) => void;
	now?: () => number;
}

export async function runElectionLoop(deps: ElectorDeps, signal: AbortSignal, sleep: (ms: number) => Promise<void>): Promise<void> {
	while (!signal.aborted) {
		try {
			const flat = await deps.store.readElectionHash();
			const workers = parseElectionHash(flat);
			const now = (deps.now ?? Date.now)();
			const priority = decideElection(workers, deps.role, deps.uuid, now);
			deps.onResult(priority, workers);
			const stale = findStaleFields(workers, now);
			if (stale.length > 0) await deps.store.deleteFields(stale);
		} catch (err) {
			deps.warn(`${deps.role}: election poll failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		await sleep(ELECTION_POLL_INTERVAL_MS);
	}
}
