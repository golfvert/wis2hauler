import { describe, expect, test } from 'bun:test';
import { buildReplayRequest, REPLAY_RATE_LIMIT_MS, triggerReplay, type ReplayRequest, type ReplayTriggerDeps } from '../replay.ts';

describe('buildReplayRequest', () => {
	test('builds the POST body/headers/url exactly like the "Extract" change node', () => {
		const req = buildReplayRequest('a/wis2/x', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 'uuid-1', 'https://replay.example/api');
		expect(req).toEqual({
			method: 'POST',
			url: 'https://replay.example/api',
			headers: ['accept: application/json', 'Content-Type: application/json'],
			body: JSON.stringify({ inputs: { datetime: '2026-09-01T00:00:00Z/2026-09-02T00:00:00Z', 'subscriber-id': 'uuid-1', topic: 'a/wis2/x' } }),
		});
	});
});

function flatFrom(workers: Record<string, Record<string, string>>): string[] {
	const flat: string[] = [];
	for (const [worker, fields] of Object.entries(workers)) {
		for (const [field, value] of Object.entries(fields)) flat.push(`${worker}:${field}`, value);
	}
	return flat;
}

describe('triggerReplay', () => {
	test('POSTs one request per discovered topic, spaced REPLAY_RATE_LIMIT_MS apart (none before the first)', async () => {
		const flat = flatFrom({ 'worker-1': { ts: '1000', topics: JSON.stringify(['a/wis2/x', 'a/wis2/y']) } });
		const posted: ReplayRequest[] = [];
		const sleeps: number[] = [];
		const deps: ReplayTriggerDeps = {
			readElectionHash: async () => flat,
			globalReplayUrl: 'https://replay.example/api',
			uuid: 'uuid-1',
			postReplayRequest: async (req) => {
				posted.push(req);
			},
			sleep: async (ms) => {
				sleeps.push(ms);
			},
			now: () => 1500,
		};
		await triggerReplay(deps, 'from-date', 'to-date');
		expect(posted.length).toBe(2);
		expect(posted.map((r) => JSON.parse(r.body).inputs.topic).sort()).toEqual(['a/wis2/x', 'a/wis2/y']);
		expect(sleeps).toEqual([REPLAY_RATE_LIMIT_MS]);
	});

	test('no discovered topics means no requests and no sleeps', async () => {
		const posted: ReplayRequest[] = [];
		const deps: ReplayTriggerDeps = {
			readElectionHash: async () => [],
			globalReplayUrl: 'https://replay.example/api',
			uuid: 'uuid-1',
			postReplayRequest: async (req) => {
				posted.push(req);
			},
			sleep: async () => {
				throw new Error('should not be called');
			},
		};
		await triggerReplay(deps, 'from-date', 'to-date');
		expect(posted.length).toBe(0);
	});
});
