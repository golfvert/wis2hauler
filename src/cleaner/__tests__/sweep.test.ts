import { describe, expect, test } from 'bun:test';
import { parseSweepMember, planSweepJob, type SweepJob } from '../sweep.ts';

describe('parseSweepMember', () => {
	test('splits on the FIRST "|" -- a value containing "|" stays intact', () => {
		expect(parseSweepMember('worker-1|a/path|with|pipes')).toEqual({ worker: 'worker-1', value: 'a/path|with|pipes' });
	});

	test('a member with no "|" is malformed -- returns null', () => {
		expect(parseSweepMember('no-pipe-here')).toBeNull();
	});

	test('an empty value after the pipe is still valid', () => {
		expect(parseSweepMember('worker-1|')).toEqual({ worker: 'worker-1', value: '' });
	});
});

describe('planSweepJob', () => {
	const deleteJob: SweepJob = { zsetKey: 'wis2gc:cleaner:pending', action: 'delete', field: 'filename' };

	test('well-formed due members each produce one XADD, and all are ZREM-ed', () => {
		const plan = planSweepJob(deleteJob, ['worker-1|a.bin', 'worker-2|b.bin']);
		expect(plan.xadds).toEqual([
			{ worker: 'worker-1', action: 'delete', field: 'filename', value: 'a.bin' },
			{ worker: 'worker-2', action: 'delete', field: 'filename', value: 'b.bin' },
		]);
		expect(plan.zremMembers).toEqual(['worker-1|a.bin', 'worker-2|b.bin']);
	});

	test('a malformed member is ZREM-ed but produces no XADD', () => {
		const plan = planSweepJob(deleteJob, ['garbage-no-pipe', 'worker-1|ok.bin']);
		expect(plan.xadds).toEqual([{ worker: 'worker-1', action: 'delete', field: 'filename', value: 'ok.bin' }]);
		expect(plan.zremMembers).toEqual(['garbage-no-pipe', 'worker-1|ok.bin']);
	});

	test('no due members produces an empty plan', () => {
		const plan = planSweepJob(deleteJob, []);
		expect(plan.xadds).toEqual([]);
		expect(plan.zremMembers).toEqual([]);
	});

	test('the cancel job uses its own action/field', () => {
		const cancelJob: SweepJob = { zsetKey: 'wis2gc:cleaner:cancel', action: 'cancel', field: 'aria2_gid' };
		const plan = planSweepJob(cancelJob, ['worker-1|abc123']);
		expect(plan.xadds).toEqual([{ worker: 'worker-1', action: 'cancel', field: 'aria2_gid', value: 'abc123' }]);
	});
});
