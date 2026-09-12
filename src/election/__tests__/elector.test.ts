import { describe, expect, test } from 'bun:test';
import { ELECTION_POLL_INTERVAL_MS, runElectionLoop, type ElectorDeps } from '../elector.ts';
import type { ElectionStore } from '../store.ts';
import type { ElectionPriority, WorkersByName } from '../elect.ts';

describe('runElectionLoop', () => {
	test('reads the hash, decides priority, reports it, and reaps any stale fields found', async () => {
		const flat = [
			'worker-1:ts', '100000',
			'worker-1:uuid', 'aaa',
			'worker-1:cleaner', 'true',
			'stale-worker:ts', '0',
			'stale-worker:uuid', 'zzz',
			'stale-worker:cleaner', 'true',
		];
		const deleted: (readonly string[])[] = [];
		const store: ElectionStore = {
			readElectionHash: async () => flat,
			writeHeartbeat: async () => {},
			deleteFields: async (fields) => {
				deleted.push(fields);
			},
		};
		const results: [ElectionPriority, WorkersByName][] = [];
		const controller = new AbortController();
		const deps: ElectorDeps = {
			store,
			role: 'cleaner',
			uuid: 'aaa',
			onResult: (priority, workers) => results.push([priority, workers]),
			warn: () => {},
			now: () => 100500,
		};
		let sleeps = 0;
		const sleep = async (): Promise<void> => {
			sleeps++;
			controller.abort();
		};
		await runElectionLoop(deps, controller.signal, sleep);
		expect(sleeps).toBe(1);
		expect(results.length).toBe(1);
		expect(results[0]![0]).toBe('primary');
		expect(deleted.length).toBe(1);
		expect([...deleted[0]!].sort()).toEqual(['stale-worker:cleaner', 'stale-worker:ts', 'stale-worker:uuid'].sort());
	});

	test('no stale fields means deleteFields is never called', async () => {
		const flat = ['worker-1:ts', '100000', 'worker-1:uuid', 'aaa', 'worker-1:cleaner', 'true'];
		let deleteCalls = 0;
		const store: ElectionStore = {
			readElectionHash: async () => flat,
			writeHeartbeat: async () => {},
			deleteFields: async () => {
				deleteCalls++;
			},
		};
		const controller = new AbortController();
		const deps: ElectorDeps = {
			store,
			role: 'cleaner',
			uuid: 'aaa',
			onResult: () => {},
			warn: () => {},
			now: () => 100500,
		};
		const sleep = async (): Promise<void> => {
			controller.abort();
		};
		await runElectionLoop(deps, controller.signal, sleep);
		expect(deleteCalls).toBe(0);
	});

	test('a read failure is warned about, not thrown, and the loop keeps going', async () => {
		const warnings: string[] = [];
		let readCalls = 0;
		const store: ElectionStore = {
			readElectionHash: async () => {
				readCalls++;
				throw new Error('redis down');
			},
			writeHeartbeat: async () => {},
			deleteFields: async () => {},
		};
		const controller = new AbortController();
		const deps: ElectorDeps = {
			store,
			role: 'cleaner',
			uuid: 'aaa',
			onResult: () => {},
			warn: (m) => warnings.push(m),
		};
		const sleep = async (): Promise<void> => {
			controller.abort();
		};
		await runElectionLoop(deps, controller.signal, sleep);
		expect(readCalls).toBe(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('redis down');
	});

	test('exports the documented 10s poll interval', () => {
		expect(ELECTION_POLL_INTERVAL_MS).toBe(10000);
	});
});
