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

	test('rejects whitelist/blacklist when SUBSCRIBER role is not active', () => {
		const result = validatePatch({ whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] }, downloaderOnly);
		expect(result.errors).toContain('whitelist: not available for current roles.');
		expect(result.values.whitelist).toBeUndefined();
	});

	test('accepts a valid whitelist for SUBSCRIBER, rejects a malformed topic in it', () => {
		const good = validatePatch({ whitelist: ['origin/a/wis2/fr-meteofrance/data/x'] }, subscriberOnly);
		expect(good.errors).toEqual([]);
		expect(good.values.whitelist).toEqual(['origin/a/wis2/fr-meteofrance/data/x']);

		const bad = validatePatch({ whitelist: ['not-a-valid-topic'] }, subscriberOnly);
		expect(bad.errors.some((e) => e.startsWith('whitelist[0]'))).toBe(true);
		expect(bad.values.whitelist).toBeUndefined();
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

	test('debug: accepts a list of roles/ALL for any active role, normalizes case, dedupes', () => {
		const result = validatePatch({ debug: ['subscriber', 'SUBSCRIBER', 'downloader'] }, new Set());
		expect(result.errors).toEqual([]);
		expect(result.values.debug).toEqual(['SUBSCRIBER', 'DOWNLOADER']);
	});

	test('debug: an empty array is valid -- it clears every dynamic category', () => {
		const result = validatePatch({ debug: [] }, new Set());
		expect(result.errors).toEqual([]);
		expect(result.values.debug).toEqual([]);
	});

	test('debug: rejects a value that is not a known role or ALL', () => {
		const result = validatePatch({ debug: ['bogus'] }, new Set());
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
