import { describe, expect, test } from 'bun:test';
import { processErrors, type XreadReply } from '../errors.ts';

describe('processErrors', () => {
	test('reshapes each entry, JSON-parses the error field, and advances lastErrorId to the last entry', () => {
		const payload: XreadReply = [
			[
				'wis2gc:error:queue-1:worker-1',
				[
					['1000-0', ['error', JSON.stringify({ code: 'FAIL', href: 'http://x' }), 'timestamp', '2026-09-10T00:00:00Z']],
					['1000-1', ['error', 'plain string error', 'timestamp', '2026-09-10T00:00:01Z']],
				],
			],
		];
		const result = processErrors(payload);
		expect(result.messages).toEqual([
			{ topic: 'wis2gc:error:queue-1:worker-1', payload: { code: 'FAIL', href: 'http://x' }, timestamp: '2026-09-10T00:00:00Z', entryId: '1000-0' },
			{ topic: 'wis2gc:error:queue-1:worker-1', payload: 'plain string error', timestamp: '2026-09-10T00:00:01Z', entryId: '1000-1' },
		]);
		expect(result.lastErrorId).toBe('1000-1');
	});

	test('an empty stream entry list yields no messages and a null lastErrorId (leave global.lastErrorId unchanged)', () => {
		const payload: XreadReply = [['wis2gc:error:queue-1:worker-1', []]];
		const result = processErrors(payload);
		expect(result.messages).toEqual([]);
		expect(result.lastErrorId).toBeNull();
	});

	test('no stream entry at all (empty top-level array) yields no messages and a null lastErrorId', () => {
		const result = processErrors([]);
		expect(result.messages).toEqual([]);
		expect(result.lastErrorId).toBeNull();
	});
});
