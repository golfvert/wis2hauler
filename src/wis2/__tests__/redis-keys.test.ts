import { describe, expect, test } from 'bun:test';
import { cacheMarkerKey, parseCacheMarkerKey } from '../redis-keys.ts';

describe('deadline marker key', () => {
	test('round-trips a downloader_id, including one containing colons', () => {
		for (const id of ['abc', 'wis2:centre:abc', 'a:b:c:d']) {
			expect(parseCacheMarkerKey(cacheMarkerKey(id))).toBe(id);
		}
	});

	test('keys that are not markers do not parse', () => {
		expect(parseCacheMarkerKey('wis2gc:downloader:downloader_id:abc')).toBeNull();
		expect(parseCacheMarkerKey('wis2gc:marker:')).toBeNull();
		expect(parseCacheMarkerKey('')).toBeNull();
	});
});
