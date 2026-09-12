import { describe, expect, test } from 'bun:test';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_ONCE_DELAY_MS, runHeartbeatLoop, type HeartbeatDeps } from '../heartbeat.ts';
import type { ElectionStore } from '../store.ts';

function fakeStore(writeHeartbeat: ElectionStore['writeHeartbeat']): ElectionStore {
	return {
		readElectionHash: async () => [],
		writeHeartbeat,
		deleteFields: async () => {},
	};
}

describe('runHeartbeatLoop', () => {
	test('waits the once-delay, then writes a heartbeat every interval until aborted', async () => {
		const writes: (readonly string[])[] = [];
		const sleeps: number[] = [];
		const store = fakeStore(async (flat) => {
			writes.push(flat);
		});
		const controller = new AbortController();
		const deps: HeartbeatDeps = {
			store,
			worker: 'worker-1',
			uuid: 'uuid-1',
			roles: { subscriber: false, downloader: false, cleaner: true, reporter: false, replayer: false },
			s3: false,
			topics: [],
			warn: () => {},
		};
		const sleep = async (ms: number): Promise<void> => {
			sleeps.push(ms);
			if (sleeps.length >= 4) controller.abort();
		};
		await runHeartbeatLoop(deps, controller.signal, sleep);
		expect(sleeps[0]).toBe(HEARTBEAT_ONCE_DELAY_MS);
		expect(sleeps.slice(1)).toEqual([HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS]);
		expect(writes.length).toBe(3);
		expect(writes[0]).toContain('worker-1:cleaner');
	});

	test('a write failure is warned about, not thrown, and the loop keeps going', async () => {
		const warnings: string[] = [];
		let calls = 0;
		const store = fakeStore(async () => {
			calls++;
			throw new Error('redis down');
		});
		const controller = new AbortController();
		const deps: HeartbeatDeps = {
			store,
			worker: 'worker-1',
			uuid: 'uuid-1',
			roles: { subscriber: false, downloader: false, cleaner: false, reporter: false, replayer: false },
			s3: false,
			topics: [],
			warn: (m) => warnings.push(m),
		};
		let sleepCount = 0;
		const sleep = async (): Promise<void> => {
			sleepCount++;
			if (sleepCount >= 2) controller.abort();
		};
		await runHeartbeatLoop(deps, controller.signal, sleep);
		expect(calls).toBe(1);
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('redis down');
	});
});
