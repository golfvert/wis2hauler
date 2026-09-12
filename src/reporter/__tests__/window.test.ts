import { describe, expect, test } from 'bun:test';
import { computeStatsWindowKey, msUntilNextWindowBoundary } from '../window.ts';

describe('computeStatsWindowKey', () => {
	test('floors seconds to the nearest 30 and zero-pads every field', () => {
		const at = new Date(2026, 8, 10, 7, 5, 42); // month is 0-indexed -> September
		expect(computeStatsWindowKey(at)).toBe('wis2gc:stats:20260910070530');
	});

	test('a time before :30 floors to :00', () => {
		const at = new Date(2026, 0, 1, 0, 0, 15);
		expect(computeStatsWindowKey(at)).toBe('wis2gc:stats:20260101000000');
	});

	test('single-digit month/day/hour/minute are zero-padded', () => {
		const at = new Date(2026, 0, 5, 3, 7, 0);
		expect(computeStatsWindowKey(at)).toBe('wis2gc:stats:20260105030700');
	});
});

describe('msUntilNextWindowBoundary', () => {
	test('computes ms remaining until the next :00/:30 mark', () => {
		const at = new Date(2026, 0, 1, 0, 0, 10, 250);
		expect(msUntilNextWindowBoundary(at)).toBe(20000 - 250);
	});

	test('right at a boundary with 0ms yields a full 30s wait', () => {
		const at = new Date(2026, 0, 1, 0, 0, 30, 0);
		expect(msUntilNextWindowBoundary(at)).toBe(30000);
	});
});
