import { describe, expect, test } from 'bun:test';
import { isValidMqttTopic, isValidCredentialTopic, isValidTopicPattern } from '../topics.ts';

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

// enforceCoreCacheRule (config-time whitelist/blacklist string rewrite)
// was removed 2026-09-19 -- see topics.ts's own removal comment. The
// WIS2 core/cache protection it used to provide is now covered by
// ../../subscriber/ingest.ts's ORIGIN_CORE_BLACKLIST_RULE /
// ORIGIN_METADATA_BLACKLIST_RULE tests instead, since that's where the
// real enforcement now lives (against each message's actual received
// topic, not the configured whitelist string).
