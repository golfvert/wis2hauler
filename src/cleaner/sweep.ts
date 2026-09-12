// The Cleaner tab's "Sweep" function node (fix_sweep_run) -- ported
// field-for-field. Fed by the "10s"... no, the "Sweep" inject
// (d00707f41c14fbb3, onceDelay 7s, repeat 2s) through the "Cleaner ?"
// gate (f9f454896525812b: cleaner-primary && cleaning-needed &&
// run-mode), which is orchestration (see run.ts), not this pure
// decision.
//
// Sweeps TWO sorted sets on every tick, each with its own action/field
// pairing:
//   - wis2gc:cleaner:pending (cleanerPendingKey()) -- scheduled by
//     Schedule (schedule.ts) above; action="delete", field="filename".
//   - wis2gc:cleaner:cancel (cleanerCancelKey()) -- scheduled by the
//     DOWNLOADER tab's scheduleCleanerCancel() (store.ts); action=
//     "cancel", field="aria2_gid".
// For each member due (ZRANGEBYSCORE 0..now), the score-set member is
// "<worker>|<value>" -- split on the FIRST '|' (matching the
// original's indexOf, not lastIndexOf: a value containing '|' stays
// intact, only the worker prefix is stripped). A malformed member (no
// '|' at all) is still removed from the ZSET (pushed onto `done`) but
// emits no XADD -- ported exactly as coded, not "fixed" into an error.
export const SWEEP_ONCE_DELAY_S = 7;
export const SWEEP_INTERVAL_S = 2;

export interface SweepJob {
	/** The ZSET key this job sweeps (cleanerPendingKey() or cleanerCancelKey()). */
	zsetKey: string;
	/** The XADD action field's value ("delete" or "cancel"). */
	action: string;
	/** The XADD field name carrying the swept value ("filename" or "aria2_gid"). */
	field: string;
}

export interface ParsedSweepMember {
	worker: string;
	value: string;
}

/** Splits a ZSET member "<worker>|<value>" on the FIRST '|', matching the original's `m.indexOf('|')`. Returns null for a malformed member (no '|'). */
export function parseSweepMember(member: string): ParsedSweepMember | null {
	const i = member.indexOf('|');
	if (i === -1) return null;
	return { worker: member.substring(0, i), value: member.substring(i + 1) };
}

/** One XADD to issue: workerCommandStreamKey(worker), id "*", fields [action, <action>, <field>, <value>] -- matches the original's `[ worker, '*', 'action', job.action, job.field, value ]` topic array exactly. */
export interface SweepXaddCommand {
	worker: string;
	action: string;
	field: string;
	value: string;
}

export interface SweepPlan {
	xadds: SweepXaddCommand[];
	/** ZREM zsetKey <every due member, valid or malformed> -- omitted (job produces none) when nothing was due. */
	zremMembers: string[];
}

/** Pure: given the due members (already ZRANGEBYSCORE'd by the caller) for one job, decides which XADDs to issue and which members to ZREM. Malformed members are still ZREM'd (matching the original's `done.push(m)` on both branches) but never XADD'd. */
export function planSweepJob(job: SweepJob, dueMembers: readonly string[]): SweepPlan {
	const xadds: SweepXaddCommand[] = [];
	const zremMembers: string[] = [];
	for (const member of dueMembers) {
		const parsed = parseSweepMember(member);
		if (parsed) xadds.push({ worker: parsed.worker, action: job.action, field: job.field, value: parsed.value });
		zremMembers.push(member);
	}
	return { xadds, zremMembers };
}
