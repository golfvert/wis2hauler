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
});
