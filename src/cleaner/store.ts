// The Redis-backed persistence the Cleaner pipeline needs, behind one
// narrow interface -- same split as ../downloader/store.ts. Every
// method corresponds to one specific Node-RED node on the Cleaner tab
// of nodered/flows.json (tab id 102b04b3eaea572e), traced node-by-node
// this session -- id and name cited in each method's own comment.
//
// The GC ("Clean Redis") surface lives in a separate GcStore interface
// (./gc.ts), not here -- it has its own mode-aware (Cluster vs
// single-node) shape that doesn't fit this store's per-call methods.
//
// Real implementation: ../redis/ioredis-cleaner-store.ts.
import type { XreadReply } from './errors.ts';

export interface CleanerStore {
	// -- Sweep (fix_sweep_run, ZRANGEBYSCORE/XADD/ZREM) --

	/** ZRANGEBYSCORE zsetKey 0 now -- the "due" members of a sweep ZSET (cleanerPendingKey() or cleanerCancelKey()). */
	dueSweepMembers(zsetKey: string, nowMs: number): Promise<string[]>;

	/** XADD workerCommandStreamKey(worker) '*' action <action> <field> <value> -- one worker-command entry per due, well-formed sweep member. */
	enqueueWorkerCommand(worker: string, action: string, field: string, value: string): Promise<void>;

	/** ZREM zsetKey <member> <member> ... -- every due member (valid or malformed) once its XADD (if any) has been issued. */
	removeSweepMembers(zsetKey: string, members: readonly string[]): Promise<void>;

	// -- Schedule (657fefb1a3a5afae, ZADD wis2gc:cleaner:pending) --

	/** ZADD cleanerPendingKey() <scoreMs> <member> -- schedules a file for future deletion. */
	scheduleCleanup(scoreMs: string, member: string): Promise<void>;

	// -- Poll Errors ("Read" d0c8b0be856355d3 -> "XREAD" f8db455e64558271) --

	/** XREAD COUNT 100 STREAMS errorStreamKey(queue, worker) lastErrorId -- null (not an empty array) when there's nothing new, matching ioredis's XREAD reply shape. */
	readErrorStream(queue: string, worker: string, lastErrorId: string): Promise<XreadReply | null>;

	quit(): Promise<void>;
}
