import { describe, expect, test } from 'bun:test';
import { buildStatsWrite, coerceKeySegment } from '../stats.ts';

describe('coerceKeySegment', () => {
	test('null coerces to the literal string "null" (JS template-literal coercion, preserved)', () => {
		expect(coerceKeySegment(null)).toBe('null');
	});
	test('a real string passes through unchanged', () => {
		expect(coerceKeySegment('centre-1')).toBe('centre-1');
	});
});

describe('buildStatsWrite', () => {
	test('builds the write command with coerced key segments and lastTimestamp defaulted to 0', () => {
		const cmd = buildStatsWrite('wis2gc:stats:20260910120000', {
			centreId: 'centre-1',
			subtopic: 'weather/x/y',
			length: 100,
			delay: 500,
			lastTimestamp: null,
			source: 'worker-1',
		});
		expect(cmd).toEqual({
			windowKey: 'wis2gc:stats:20260910120000',
			centreIdSegment: 'centre-1',
			subtopicSegment: 'weather/x/y',
			length: 100,
			delay: 500,
			lastTimestamp: 0,
			source: 'worker-1',
		});
	});

	test('a null centreId/subtopic becomes the literal "null" segment, not dropped', () => {
		const cmd = buildStatsWrite('w', { centreId: null, subtopic: null, length: 0, delay: null, lastTimestamp: null, source: null });
		expect(cmd.centreIdSegment).toBe('null');
		expect(cmd.subtopicSegment).toBe('null');
		expect(cmd.source).toBeNull();
	});
});
