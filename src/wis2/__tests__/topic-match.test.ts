import { describe, expect, test } from 'bun:test';
import { matchesTopicPattern, stripReplayPrefix, isBlacklisted } from '../topic-match.ts';

describe('matchesTopicPattern', () => {
	test('literal match', () => {
		expect(matchesTopicPattern('a/b/c', 'a/b/c')).toBe(true);
		expect(matchesTopicPattern('a/b/c', 'a/b/d')).toBe(false);
	});
	test('+ matches exactly one level', () => {
		expect(matchesTopicPattern('a/b/c', 'a/+/c')).toBe(true);
		expect(matchesTopicPattern('a/b/c/d', 'a/+/c')).toBe(false); // topic longer than pattern
	});
	test('# matches everything remaining, including zero extra levels', () => {
		expect(matchesTopicPattern('a/b/c/d/e', '+/+/+/+/+/recommended/#')).toBe(false);
		expect(matchesTopicPattern('a/b/c', 'a/b/#')).toBe(true);
		expect(matchesTopicPattern('a/b', 'a/b/#')).toBe(true); // # also matches zero remaining levels, same as a real MQTT broker
	});
	test('a shorter topic than the pattern never matches (short of #)', () => {
		expect(matchesTopicPattern('a/b', 'a/b/c')).toBe(false);
	});
});

describe('stripReplayPrefix', () => {
	test('strips the replay/a/wis2/<centre>/<uuid>/ wrapper', () => {
		expect(stripReplayPrefix('replay/a/wis2/fr-meteofrance/abc-123/origin/a/wis2/fr-meteofrance/data/x'))
			.toBe('origin/a/wis2/fr-meteofrance/data/x');
	});
	test('leaves a non-replay topic untouched', () => {
		expect(stripReplayPrefix('origin/a/wis2/fr-meteofrance/data/x')).toBe('origin/a/wis2/fr-meteofrance/data/x');
	});
});

describe('isBlacklisted', () => {
	test('matches the global-cache "recommended" blacklist pattern', () => {
		expect(isBlacklisted('origin/a/wis2/us-noaa/data/recommended/x', ['+/+/+/+/+/recommended/#'])).toBe(true);
	});
	test('empty blacklist blocks nothing', () => {
		expect(isBlacklisted('origin/a/wis2/us-noaa/data/x', [])).toBe(false);
	});
	test('no pattern matches -> not blacklisted', () => {
		expect(isBlacklisted('origin/a/wis2/us-noaa/data/x', ['cache/a/wis2/+/+/+'])).toBe(false);
	});

	// ../../subscriber/ingest.ts's ORIGIN_CORE_BLACKLIST_RULE /
	// ORIGIN_METADATA_BLACKLIST_RULE -- the ingest-time safeguard that
	// replaced config-time whitelist rewriting (see that file's and
	// ../../config/topics.ts's removal comments). Exercised here against
	// the real matcher, since the whole point is that these patterns
	// catch a message's ACTUAL topic regardless of how broadly it was
	// subscribed to.
	describe('the origin core/metadata safeguard patterns', () => {
		// Literal values, same convention as the "recommended" pattern
		// test above -- kept identical to ../../subscriber/ingest.ts's
		// exported ORIGIN_CORE_BLACKLIST_RULE / ORIGIN_METADATA_BLACKLIST_RULE.
		const rules = ['origin/+/+/+/data/core/#', 'origin/+/+/+/metadata/#'];

		test('blocks a core-data topic pulled straight from origin, at any depth', () => {
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/data/core/weather/surface', rules)).toBe(true);
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/data/core', rules)).toBe(true);
		});
		test('blocks a metadata notification straight from origin, whether or not it goes deeper', () => {
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/metadata', rules)).toBe(true);
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/metadata/discovery', rules)).toBe(true);
		});
		test('does not block recommended data from origin', () => {
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/data/recommended/x', rules)).toBe(false);
		});
		test('does not block core/metadata once republished under cache/... (only origin/... is restricted)', () => {
			expect(isBlacklisted('cache/a/wis2/fr-meteofrance/data/core/weather/surface', rules)).toBe(false);
			expect(isBlacklisted('cache/a/wis2/fr-meteofrance/metadata', rules)).toBe(false);
		});
		test('a broad wildcard whitelist subscription does not matter -- this runs against the real received topic', () => {
			// This is exactly the case that the old config-time whitelist
			// rewrite could not catch: someone subscribed to everything
			// under a centre with 'origin/a/wis2/#', and a core-data
			// message arrives on it regardless.
			expect(isBlacklisted('origin/a/wis2/fr-meteofrance/data/core/weather/surface', rules)).toBe(true);
		});
	});
});
