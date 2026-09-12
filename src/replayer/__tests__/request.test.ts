import { describe, expect, test } from 'bun:test';
import { validateReplayerRequest } from '../request.ts';

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0); // 2026-09-09T12:00:00Z

describe('validateReplayerRequest', () => {
	test('global-replay alone: accepted, no replay range', () => {
		const result = validateReplayerRequest({ 'global-replay': 'https://replay.example.org/wis2gc' }, NOW);
		expect(result.errors).toEqual([]);
		expect(result.patch).toEqual({ globalReplay: 'https://replay.example.org/wis2gc' });
	});

	test('replay: computes ISO from/to bounds from minutes-ago', () => {
		const result = validateReplayerRequest({ replay: { from: 120, to: 60 } }, NOW);
		expect(result.errors).toEqual([]);
		expect(result.patch.replayRange).toEqual({
			from: '2026-09-09T10:00:00.000Z',
			to: '2026-09-09T11:00:00.000Z',
		});
	});

	test('replay: to=0 means open-ended, represented as the literal ".."', () => {
		const result = validateReplayerRequest({ replay: { from: 30, to: 0 } }, NOW);
		expect(result.errors).toEqual([]);
		expect(result.patch.replayRange).toEqual({ from: '2026-09-09T11:30:00.000Z', to: '..' });
	});

	test('replay: from must be greater than to', () => {
		const result = validateReplayerRequest({ replay: { from: 10, to: 10 } }, NOW);
		expect(result.errors).toContain('replay.from must be greater than replay.to.');
		expect(result.patch.replayRange).toBeUndefined();
	});

	test('replay: from must be positive, to must be non-negative', () => {
		expect(validateReplayerRequest({ replay: { from: 0, to: 0 } }, NOW).errors).toContain('replay.from: must be a positive number (minutes ago).');
		expect(validateReplayerRequest({ replay: { from: 10, to: -5 } }, NOW).errors).toContain('replay.to: must be a non-negative number (minutes ago).');
	});

	test('both fields together', () => {
		const result = validateReplayerRequest({ 'global-replay': 'https://replay.example.org/wis2gc', replay: { from: 5, to: 0 } }, NOW);
		expect(result.errors).toEqual([]);
		expect(result.patch.globalReplay).toBe('https://replay.example.org/wis2gc');
		expect(result.patch.replayRange).toEqual({ from: '2026-09-09T11:55:00.000Z', to: '..' });
	});

	test('non-object body is rejected', () => {
		expect(validateReplayerRequest('nope', NOW).errors).toEqual(['Body must be a JSON object.']);
		expect(validateReplayerRequest(null, NOW).errors).toEqual(['Body must be a JSON object.']);
	});

	test('empty body: no errors, no patch', () => {
		const result = validateReplayerRequest({}, NOW);
		expect(result.errors).toEqual([]);
		expect(result.patch).toEqual({});
	});
});
