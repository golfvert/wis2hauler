import { describe, expect, test } from 'bun:test';
import { validatePatch, isKeyAllowed, type ValidatePatchOptions } from '../runtime.ts';
import type { Role } from '../schema.ts';

const subscriberOnly = new Set<Role>(['SUBSCRIBER']);
const downloaderOnly = new Set<Role>(['DOWNLOADER']);

// Most tests below don't care about the WIS2 core/cache rule at all --
// this is the "not a Global Cache, and nothing logged" default every
// call passes unless a test is specifically exercising that rule (see
// the dedicated describe block at the bottom).
function opts(overrides: Partial<ValidatePatchOptions> = {}): ValidatePatchOptions {
	return { globalCacheMode: false, warn: () => {}, ...overrides };
}

describe('validatePatch', () => {
	test('accepts process-mode/log-level for any role', () => {
		const result = validatePatch({ 'process-mode': 'halt', 'log-level': 'debug' }, new Set(), opts());
		expect(result.errors).toEqual([]);
		expect(result.values['process-mode']).toBe('halt');
		expect(result.values['log-level']).toBe('debug');
	});

	test('rejects an unknown key', () => {
		const result = validatePatch({ bogus: true }, subscriberOnly, opts());
		expect(result.errors).toContain('bogus: unknown key.');
	});

	test('rejects whitelist/blacklist when SUBSCRIBER role is not active', () => {
		const result = validatePatch({ whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] }, downloaderOnly, opts());
		expect(result.errors).toContain('whitelist: not available for current roles.');
		expect(result.values.whitelist).toBeUndefined();
	});

	test('accepts a valid whitelist for SUBSCRIBER, rejects a malformed topic in it', () => {
		const good = validatePatch({ whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] }, subscriberOnly, opts());
		expect(good.errors).toEqual([]);
		expect(good.values.whitelist).toEqual(['origin/a/wis2/fr-meteofrance/data/x']);

		const bad = validatePatch({ whitelist: ['not-a-valid-topic'] }, subscriberOnly, opts());
		expect(bad.errors.some((e) => e.startsWith('whitelist[0]'))).toBe(true);
		expect(bad.values.whitelist).toBeUndefined();
	});

	test('credentials CRUD: create requires username/password, delete does not', () => {
		const create = validatePatch(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' } },
			downloaderOnly,
			opts(),
		);
		expect(create.errors).toEqual([]);
		expect(create.values.credentials).toEqual({ op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u', password: 'p' });

		const del = validatePatch({ credentials: { op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' } }, downloaderOnly, opts());
		expect(del.errors).toEqual([]);
		expect(del.values.credentials).toEqual({ op: 'delete', topic: 'origin/a/wis2/us-noaa/data/recommended' });

		const missingPassword = validatePatch(
			{ credentials: { op: 'create', topic: 'origin/a/wis2/us-noaa/data/recommended', username: 'u' } },
			downloaderOnly,
			opts(),
		);
		expect(missingPassword.errors).toContain('credentials.password: missing or empty');
	});

	test('debug: accepts a list of roles/ALL for any active role, normalizes case, dedupes', () => {
		const result = validatePatch({ debug: ['subscriber', 'SUBSCRIBER', 'downloader'] }, new Set(), opts());
		expect(result.errors).toEqual([]);
		expect(result.values.debug).toEqual(['SUBSCRIBER', 'DOWNLOADER']);
	});

	test('debug: an empty array is valid -- it clears every dynamic category', () => {
		const result = validatePatch({ debug: [] }, new Set(), opts());
		expect(result.errors).toEqual([]);
		expect(result.values.debug).toEqual([]);
	});

	test('debug: rejects a value that is not a known role or ALL', () => {
		const result = validatePatch({ debug: ['bogus'] }, new Set(), opts());
		expect(result.errors.some((e) => e.startsWith('debug[0]'))).toBe(true);
		expect(result.values.debug).toBeUndefined();
	});

	test('isKeyAllowed matches the role map directly', () => {
		expect(isKeyAllowed('process-mode', new Set())).toBe(true);
		expect(isKeyAllowed('credentials', downloaderOnly)).toBe(true);
		expect(isKeyAllowed('credentials', subscriberOnly)).toBe(false);
		expect(isKeyAllowed('nope', subscriberOnly)).toBe(false);
	});

	test('log-level-role: accepts a role+level override, available to any role', () => {
		const result = validatePatch({ 'log-level-role': { role: 'subscriber', value: 'debug' } }, new Set(), opts());
		expect(result.errors).toEqual([]);
		expect(result.values['log-level-role']).toEqual({ role: 'SUBSCRIBER', value: 'debug' });
	});

	test('log-level-role: value null clears an override', () => {
		const result = validatePatch({ 'log-level-role': { role: 'SUBSCRIBER', value: null } }, new Set(), opts());
		expect(result.errors).toEqual([]);
		expect(result.values['log-level-role']).toEqual({ role: 'SUBSCRIBER', value: null });
	});

	test('log-level-role: rejects an unknown role or invalid level', () => {
		const badRole = validatePatch({ 'log-level-role': { role: 'BOGUS', value: 'debug' } }, new Set(), opts());
		expect(badRole.errors.some((e) => e.startsWith('log-level-role.role'))).toBe(true);

		const badLevel = validatePatch({ 'log-level-role': { role: 'SUBSCRIBER', value: 'verbose' } }, new Set(), opts());
		expect(badLevel.errors.some((e) => e.startsWith('log-level-role.value'))).toBe(true);
	});
});

describe('validatePatch: WIS2 core/cache rule (whitelist/blacklist)', () => {
	test('whitelist: rewrites origin/.../core/... to cache/... and logs, when not a Global Cache', () => {
		const messages: string[] = [];
		const result = validatePatch(
			{ whitelist: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'] },
			subscriberOnly,
			opts({ warn: (m) => messages.push(m) }),
		);
		expect(result.errors).toEqual([]);
		expect(result.values.whitelist).toEqual(['cache/a/wis2/fr-meteofrance/data/core/weather/surface']);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('whitelist:');
		expect(messages[0]).toContain("'origin/a/wis2/fr-meteofrance/data/core/weather/surface'");
	});

	test('blacklist: rewritten the same way, for consistency with whitelist', () => {
		const messages: string[] = [];
		const result = validatePatch(
			{ blacklist: ['origin/a/wis2/fr-meteofrance/data/core/#'] },
			subscriberOnly,
			opts({ warn: (m) => messages.push(m) }),
		);
		expect(result.errors).toEqual([]);
		expect(result.values.blacklist).toEqual(['cache/a/wis2/fr-meteofrance/data/core/#']);
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain('blacklist:');
	});

	test('leaves origin/.../core/... alone when this replica is a Global Cache', () => {
		const messages: string[] = [];
		const result = validatePatch(
			{ whitelist: ['origin/a/wis2/fr-meteofrance/data/core/weather/surface'] },
			subscriberOnly,
			opts({ globalCacheMode: true, warn: (m) => messages.push(m) }),
		);
		expect(result.errors).toEqual([]);
		expect(result.values.whitelist).toEqual(['origin/a/wis2/fr-meteofrance/data/core/weather/surface']);
		expect(messages).toEqual([]);
	});

	test('leaves non-core and already-cache topics untouched', () => {
		const result = validatePatch(
			{ whitelist: ['origin/a/wis2/fr-meteofrance/data/recommended/x', 'cache/a/wis2/us-noaa/data/core/y'] },
			subscriberOnly,
			opts(),
		);
		expect(result.errors).toEqual([]);
		expect(result.values.whitelist).toEqual(['origin/a/wis2/fr-meteofrance/data/recommended/x', 'cache/a/wis2/us-noaa/data/core/y']);
	});
});
