import { describe, expect, test } from 'bun:test';
import { compareStreamIds, streamIdMinusMs } from '../stream-id.ts';

describe('compareStreamIds', () => {
	test('orders by the millisecond half first', () => {
		expect(compareStreamIds('1000-0', '2000-0')).toBeLessThan(0);
		expect(compareStreamIds('2000-0', '1000-0')).toBeGreaterThan(0);
	});

	test('orders by the sequence half at equal millisecond', () => {
		expect(compareStreamIds('1000-0', '1000-1')).toBeLessThan(0);
		expect(compareStreamIds('1000-5', '1000-2')).toBeGreaterThan(0);
	});

	test('equal ids compare equal', () => {
		expect(compareStreamIds('1700000000000-3', '1700000000000-3')).toBe(0);
	});

	// The specific case plain string comparison gets wrong: "9-0" sorts
	// AFTER "10-0" lexicographically even though 9 < 10 numerically --
	// this function must not have that bug, even though real Hauler ids
	// never actually hit it (13-digit millis always).
	test('is numeric, not lexicographic, across differing digit counts', () => {
		expect(compareStreamIds('9-0', '10-0')).toBeLessThan(0);
		expect('9-0' > '10-0').toBe(true); // the lexicographic trap this function avoids
	});

	test('"0-0" (runConsumerLoop\'s own startId default) compares as the oldest possible id', () => {
		expect(compareStreamIds('0-0', '1700000000000-0')).toBeLessThan(0);
	});
});

describe('streamIdMinusMs', () => {
	test('subtracts the margin from the millisecond half, sequence reset to 0', () => {
		expect(streamIdMinusMs('1700000000000-7', 60_000)).toBe('1699999940000-0');
	});

	test('clamps at "0-0" instead of going negative when the margin exceeds the id', () => {
		expect(streamIdMinusMs('1000-0', 5000)).toBe('0-0');
	});

	test('a zero margin returns the same millisecond, sequence reset to 0', () => {
		expect(streamIdMinusMs('1700000000000-3', 0)).toBe('1700000000000-0');
	});
});
