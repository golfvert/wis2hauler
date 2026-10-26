import { describe, expect, test } from 'bun:test';
import { validatePatch, isKeyAllowed } from '../runtime.ts';
import type { Role } from '../schema.ts';

const subscriberOnly = new Set<Role>(['SUBSCRIBER']);
const downloaderOnly = new Set<Role>(['DOWNLOADER']);

describe('validatePatch', () => {
	test('accepts process-mode/log-level for any role', () => {
		const result = validatePatch({ 'process-mode': 'halt', 'log-level': 'debug' }, new Set());
		expect(result.errors).toEqual([]);
		expect(result.values['process-mode']).toBe('halt');
		expect(result.values['log-level']).toBe('debug');
	});

	test('rejects an unknown key', () => {
		const result = validatePatch({ bogus: true }, subscriberOnly);
		expect(result.errors).toContain('bogus: unknown key.');
	});

	test('rejects subscribe/exclude when SUBSCRIBER role is not active', () => {
		const result = validatePatch({ subscribe: ['origin/a/wis2/fr-meteofrance/data/x'] }, downloaderOnly);
		expect(result.errors).toContain('subscribe: not available for current roles.');
		expect(result.values.subscribe).toBeUndefined();
	});

	test('accepts a valid subscribe for SUBSCRIBER, rejects a malformed topic in it', () => {
		const good = validatePatch({ subscribe: ['origin/a/wis2/fr-meteofrance/data/x'] }, subscriberOnly);
		expect(good.errors).toEqual([]);
		expect(good.values.subscribe).toEqual(['origin/a/wis2/fr-meteofrance/data/x']);

		const bad = validatePatch({ subscribe: ['not-a-valid-topic'] }, subscriberOnly);
		expect(bad.errors.some((e) => e.startsWith('subscribe[0]'))).toBe(true);
		expect(bad.values.subscribe).toBeUndefined();
	});

	test('credentials CRUD: create requires username/password, delete does not', () => {
		const create = validatePatch(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' } },
			downloaderOnly,
		);
		expect(create.errors).toEqual([]);
		expect(create.values.credentials).toEqual({ op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' });

		const del = validatePatch({ credentials: { op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' } }, downloaderOnly);
		expect(del.errors).toEqual([]);
		expect(del.values.credentials).toEqual({ op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' });

		const missingPassword = validatePatch(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u' } },
			downloaderOnly,
		);
		expect(missingPassword.errors).toContain('credentials.password: missing or empty');
	});

	test('debug key is gone: validatePatch rejects it as unknown', () => {
		const result = validatePatch({ debug: ['subscriber'] }, new Set());
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.values).not.toHaveProperty('debug');
	});

	test('isKeyAllowed matches the role map directly', () => {
		expect(isKeyAllowed('process-mode', new Set())).toBe(true);
		expect(isKeyAllowed('credentials', downloaderOnly)).toBe(true);
		expect(isKeyAllowed('credentials', subscriberOnly)).toBe(false);
		expect(isKeyAllowed('nope', subscriberOnly)).toBe(false);
	});

	test('log-level-role: accepts a role+level override, available to any role', () => {
		const result = validatePatch({ 'log-level-role': { role: 'subscriber', value: 'debug' } }, new Set());
		expect(result.errors).toEqual([]);
		expect(result.values['log-level-role']).toEqual({ role: 'SUBSCRIBER', value: 'debug' });
	});

	test('log-level-role: value null clears an override', () => {
		const result = validatePatch({ 'log-level-role': { role: 'SUBSCRIBER', value: null } }, new Set());
		expect(result.errors).toEqual([]);
		expect(result.values['log-level-role']).toEqual({ role: 'SUBSCRIBER', value: null });
	});

	test('log-level-role: rejects an unknown role or invalid level', () => {
		const badRole = validatePatch({ 'log-level-role': { role: 'BOGUS', value: 'debug' } }, new Set());
		expect(badRole.errors.some((e) => e.startsWith('log-level-role.role'))).toBe(true);

		const badLevel = validatePatch({ 'log-level-role': { role: 'SUBSCRIBER', value: 'verbose' } }, new Set());
		expect(badLevel.errors.some((e) => e.startsWith('log-level-role.value'))).toBe(true);
	});
});

// The WIS2 core/cache rule used to rewrite an origin/.../core/...
// subscribe list/exclude list entry to cache/... right here (enforceCoreCacheRule,
// removed 2026-09-19 -- see ../topics.ts's removal comment: a broad
// wildcard entry bypassed it entirely, and nothing downstream ever
// re-checked a message's ACTUAL topic once received). validatePatch no
// longer rewrites subscribe list/exclude list entries at all -- the equivalent
// protection now runs at message-ingest time against each message's
// real topic (../../subscriber/ingest.ts's ORIGIN_CORE_EXCLUDE_RULE /
// ORIGIN_METADATA_EXCLUDE_RULE), which a POST /set patch benefits
// from for free since it's applied regardless of how the subscribe list was
// set.
describe('validatePatch: subscribe/exclude entries are passed through untouched', () => {
	test('an origin/.../core/... entry is no longer rewritten', () => {
		const result = validatePatch(
			{ subscribe: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'] },
			subscriberOnly,
		);
		expect(result.errors).toEqual([]);
		expect(result.values.subscribe).toEqual(['origin/a/wis2/fr-meteofrance/data/core/weather/surface']);
	});

	test('a exclude entry naming origin/.../core/... is no longer rewritten either', () => {
		const result = validatePatch({ exclude: ['origin/a/wis2/fr-meteofrance/data/core/#'] }, subscriberOnly);
		expect(result.errors).toEqual([]);
		expect(result.values.exclude).toEqual(['origin/a/wis2/fr-meteofrance/data/core/#']);
	});

	test('leaves non-core and already-cache topics untouched too', () => {
		const result = validatePatch(
			{ subscribe: ['origin/a/wis2/fr-meteofrance/data/recommended/x', 'cache/a/wis2/us-noaa/data/core/y'] },
			subscriberOnly,
		);
		expect(result.errors).toEqual([]);
		expect(result.values.subscribe).toEqual(['origin/a/wis2/fr-meteofrance/data/recommended/x', 'cache/a/wis2/us-noaa/data/core/y']);
	});
});

describe('validatePatch — deprecated whitelist/blacklist keys (ADR 0012)', () => {
	test('whitelist/blacklist are mapped to subscribe/exclude and reported as deprecated', () => {
		const result = validatePatch({ whitelist: ['cache/a/wis2/#'], blacklist: ['+/+/+/+/+/+/+/experimental/#'] }, subscriberOnly);
		expect(result.errors).toEqual([]);
		expect(result.values.subscribe).toEqual(['cache/a/wis2/#']);
		expect(result.values.exclude).toEqual(['+/+/+/+/+/+/+/experimental/#']);
		expect(result.deprecated).toEqual(["whitelist: deprecated, use 'subscribe'.", "blacklist: deprecated, use 'exclude'."]);
	});

	test('new names alone report no deprecation', () => {
		const result = validatePatch({ subscribe: ['cache/a/wis2/#'] }, subscriberOnly);
		expect(result.errors).toEqual([]);
		expect(result.deprecated).toBeUndefined();
	});

	test('sending both spellings of one key is an error', () => {
		const result = validatePatch({ whitelist: ['cache/a/wis2/#'], subscribe: ['cache/a/wis2/#'] }, subscriberOnly);
		expect(result.errors.some((e) => e.startsWith("whitelist: deprecated name of 'subscribe'"))).toBe(true);
	});

	test('old names still respect the role gate', () => {
		const result = validatePatch({ whitelist: ['cache/a/wis2/#'] }, downloaderOnly);
		expect(result.errors).toContain('subscribe: not available for current roles.');
	});
});
