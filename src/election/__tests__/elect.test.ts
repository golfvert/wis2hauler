import { describe, expect, test } from 'bun:test';
import {
	buildHeartbeatFields,
	computeCleaningNeeded,
	decideElection,
	findStaleFields,
	parseElectionHash,
} from '../elect.ts';

describe('parseElectionHash', () => {
	test('groups flat field/value pairs by worker, splitting on the last colon', () => {
		const flat = ['worker-1:ts', '1000', 'worker-1:uuid', 'aaa', 'worker-2:ts', '2000', 'worker-2:uuid', 'bbb'];
		expect(parseElectionHash(flat)).toEqual({
			'worker-1': { ts: '1000', uuid: 'aaa' },
			'worker-2': { ts: '2000', uuid: 'bbb' },
		});
	});

	test('empty hash yields no workers', () => {
		expect(parseElectionHash([])).toEqual({});
	});

	test('a worker name that itself contains a colon splits on the LAST colon', () => {
		const flat = ['host:1:ts', '1000'];
		expect(parseElectionHash(flat)).toEqual({ 'host:1': { ts: '1000' } });
	});
});

describe('decideElection', () => {
	test('this replica is primary when it holds the lowest uuid among alive role-holders', () => {
		const workers = {
			a: { ts: '1000', uuid: 'aaa', cleaner: 'true' },
			b: { ts: '1000', uuid: 'bbb', cleaner: 'true' },
		};
		expect(decideElection(workers, 'cleaner', 'aaa', 1500)).toBe('primary');
		expect(decideElection(workers, 'cleaner', 'bbb', 1500)).toBe('secondary');
	});

	test('workers not carrying this role are ignored', () => {
		const workers = {
			a: { ts: '1000', uuid: 'aaa', cleaner: 'false' },
			b: { ts: '1000', uuid: 'bbb', cleaner: 'true' },
		};
		expect(decideElection(workers, 'cleaner', 'bbb', 1500)).toBe('primary');
	});

	test('a stale worker (ts too old) is excluded even if it would otherwise win', () => {
		const workers = {
			a: { ts: '0', uuid: 'aaa', cleaner: 'true' },
			b: { ts: '8500', uuid: 'bbb', cleaner: 'true' },
		};
		// now=9000: worker a's age is 9000ms >= ELECTION_ALIVE_MS(8000), so it's excluded;
		// worker b's age is only 500ms, so it's still alive and wins by default.
		expect(decideElection(workers, 'cleaner', 'bbb', 9000)).toBe('primary');
	});

	test('no alive role-holders at all means this replica is never primary', () => {
		expect(decideElection({}, 'cleaner', 'aaa', 1000)).toBe('secondary');
	});
});

describe('findStaleFields', () => {
	test('flags every field of a worker whose ts is >= 60000ms old', () => {
		const workers = {
			stale: { ts: '0', uuid: 'x' },
			fresh: { ts: '59000', uuid: 'y' },
		};
		expect(findStaleFields(workers, 60000).sort()).toEqual(['stale:ts', 'stale:uuid'].sort());
	});

	test('nothing stale yields an empty array', () => {
		const workers = { a: { ts: '59999', uuid: 'x' } };
		expect(findStaleFields(workers, 60000)).toEqual([]);
	});
});

describe('computeCleaningNeeded', () => {
	test('true when an alive downloader is NOT on s3 (local files need cleaning)', () => {
		const workers = { a: { ts: '1000', downloader: 'true', s3: 'false' } };
		expect(computeCleaningNeeded(workers, 1500)).toBe(true);
	});

	test('false when every alive downloader is on s3', () => {
		const workers = { a: { ts: '1000', downloader: 'true', s3: 'true' } };
		expect(computeCleaningNeeded(workers, 1500)).toBe(false);
	});

	test('true when there is no alive downloader at all', () => {
		expect(computeCleaningNeeded({}, 1500)).toBe(true);
	});

	test('a stale downloader entry does not count as alive', () => {
		const workers = { a: { ts: '0', downloader: 'true', s3: 'true' } };
		expect(computeCleaningNeeded(workers, 9000)).toBe(true);
	});
});

describe('buildHeartbeatFields', () => {
	test('emits all 9 flat field/value pairs for this worker', () => {
		const fields = buildHeartbeatFields(
			'worker-1',
			'uuid-1',
			{ subscriber: true, downloader: false, cleaner: true, reporter: false, replayer: false },
			true,
			['a/b/c', { topic: 'd/e/f', qos: 1 }],
		);
		expect(fields).toEqual([
			'worker-1:ts', fields[1]!,
			'worker-1:uuid', 'uuid-1',
			'worker-1:subscriber', 'true',
			'worker-1:downloader', 'false',
			'worker-1:cleaner', 'true',
			'worker-1:reporter', 'false',
			'worker-1:replayer', 'false',
			'worker-1:s3', 'true',
			'worker-1:topics', JSON.stringify(['a/b/c', { topic: 'd/e/f', qos: 1 }]),
		]);
		expect(Number(fields[1])).toBeGreaterThan(0);
	});
});
