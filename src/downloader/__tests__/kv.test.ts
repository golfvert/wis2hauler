import { describe, expect, test } from 'bun:test';
import { parseFlatRecord } from '../kv.ts';

describe('parseFlatRecord', () => {
	test('parses a well-formed flat array into an object', () => {
		expect(parseFlatRecord(['a', '1', 'b', '2'])).toEqual({ a: '1', b: '2' });
	});

	test('empty array -> empty object', () => {
		expect(parseFlatRecord([])).toEqual({});
	});

	test('a dangling trailing key with no value defaults to empty string', () => {
		expect(parseFlatRecord(['a', '1', 'b'])).toEqual({ a: '1', b: '' });
	});

	test('later duplicate keys overwrite earlier ones, matching object-literal-from-array semantics', () => {
		expect(parseFlatRecord(['a', '1', 'a', '2'])).toEqual({ a: '2' });
	});
});
