import { describe, expect, test } from 'bun:test';
import { isValidMqttTopic, isValidCredentialTopic, isValidTopicPattern, enforceCoreCacheRule } from '../topics.ts';

describe('isValidMqttTopic', () => {
	test('accepts a well-formed WIS2 data topic', () => {
		expect(isValidMqttTopic('origin/a/wis2/fr-meteofrance/data/warnings/latest')).toBeNull();
	});
	test('accepts wildcards in the tail', () => {
		expect(isValidMqttTopic('cache/a/wis2/fr-meteofrance/metadata/#')).toBeNull();
		expect(isValidMqttTopic('+/a/wis2/+/data/#')).toBeNull();
	});
	test('rejects a bad level-1 segment', () => {
		expect(isValidMqttTopic('bogus/a/wis2/fr-meteofrance/data/x')).toMatch(/level 1/);
	});
	test('rejects a level-4 (centre-id) segment without a hyphen', () => {
		expect(isValidMqttTopic('origin/a/wis2/meteofrance/data/x')).toMatch(/level 4/);
	});
	test('rejects # anywhere but last', () => {
		expect(isValidMqttTopic('origin/a/wis2/fr-meteofrance/#/data')).toMatch(/last level/);
	});
	test('rejects empty/non-string input', () => {
		expect(isValidMqttTopic('')).toMatch(/empty/);
		expect(isValidMqttTopic(undefined)).toMatch(/empty/);
	});
});

describe('isValidCredentialTopic', () => {
	test('accepts an origin/.../recommended topic', () => {
		expect(isValidCredentialTopic('origin/a/wis2/us-noaa/data/recommended')).toBeNull();
	});
	test('rejects a non-origin level 1', () => {
		expect(isValidCredentialTopic('cache/a/wis2/us-noaa/data/recommended')).toMatch(/must start with 'origin'/);
	});
	test("rejects a level-5 that isn't 'recommended'", () => {
		expect(isValidCredentialTopic('origin/a/wis2/us-noaa/data/x')).toMatch(/'data'|'recommended'/);
	});
});

describe('isValidTopicPattern', () => {
	test('accepts blacklist-style wildcard patterns', () => {
		expect(isValidTopicPattern('+/+/+/+/+/recommended/#')).toBe(true);
	});
	test('rejects characters outside the allowed set', () => {
		expect(isValidTopicPattern('origin/a/wis2/fr-meteofrance/data/(bad)')).toBe(false);
	});
});

describe('enforceCoreCacheRule', () => {
	test('rewrites origin/.../core/... to cache/... and logs, when not a Global Cache', () => {
		const messages: string[] = [];
		const result = enforceCoreCacheRule(
			['origin/a/wis2/fr-meteofrance/data/core/weather/surface'],
			false,
			(m) => messages.push(m),
		);
		expect(result).toEqual(['cache/a/wis2/fr-meteofrance/data/core/weather/surface']);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("'origin/a/wis2/fr-meteofrance/data/core/weather/surface'");
		expect(messages[0]).toContain("'cache/a/wis2/fr-meteofrance/data/core/weather/surface'");
	});

	test('leaves origin/.../core/... alone when this replica IS a Global Cache', () => {
		const messages: string[] = [];
		const result = enforceCoreCacheRule(
			['origin/a/wis2/fr-meteofrance/data/core/weather/surface'],
			true,
			(m) => messages.push(m),
		);
		expect(result).toEqual(['origin/a/wis2/fr-meteofrance/data/core/weather/surface']);
		expect(messages).toEqual([]);
	});

	test('leaves a non-core topic under origin untouched', () => {
		const result = enforceCoreCacheRule(['origin/a/wis2/fr-meteofrance/data/recommended/x'], false, () => {});
		expect(result).toEqual(['origin/a/wis2/fr-meteofrance/data/recommended/x']);
	});

	test('leaves a topic already under cache untouched', () => {
		const result = enforceCoreCacheRule(['cache/a/wis2/fr-meteofrance/data/core/x'], false, () => {});
		expect(result).toEqual(['cache/a/wis2/fr-meteofrance/data/core/x']);
	});

	test('does not guess at wildcards -- a "+" at level 1 or level 6 is left alone', () => {
		const result = enforceCoreCacheRule(
			['+/a/wis2/fr-meteofrance/data/core/x', 'origin/a/wis2/fr-meteofrance/data/+/x'],
			false,
			() => {},
		);
		expect(result).toEqual(['+/a/wis2/fr-meteofrance/data/core/x', 'origin/a/wis2/fr-meteofrance/data/+/x']);
	});

	test('applies identically to a blacklist-style pattern (with a trailing #)', () => {
		const messages: string[] = [];
		const result = enforceCoreCacheRule(['origin/a/wis2/fr-meteofrance/data/core/#'], false, (m) => messages.push(m));
		expect(result).toEqual(['cache/a/wis2/fr-meteofrance/data/core/#']);
		expect(messages).toHaveLength(1);
	});

	test('is a no-op on an empty list', () => {
		expect(enforceCoreCacheRule([], false, () => {})).toEqual([]);
	});
});
