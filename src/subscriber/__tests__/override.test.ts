import { describe, expect, test } from 'bun:test';
import { evaluateOverride } from '../override.ts';
import type { Wnm } from '../../wis2/wnm.ts';
import type { OverrideRule } from '../../config/schema.ts';

const wnmWithLength = (length: number): Wnm => ({
	id: 'msg-1',
	links: [{ rel: 'canonical', href: 'https://a', length }],
	properties: { pubtime: '2026-09-09T00:00:00Z', data_id: 'urn:x:1' },
});

describe('evaluateOverride', () => {
	test('no overridelist -> never overridden', () => {
		expect(evaluateOverride(wnmWithLength(10), 'origin/a/wis2/x/data/y', undefined)).toEqual({ override: false });
	});

	test('topic-only rule matches by topic pattern (after replay-stripping)', () => {
		const rules: OverrideRule[] = [{ topic: 'origin/a/wis2/x/data/#' }];
		const result = evaluateOverride(wnmWithLength(10), 'replay/a/wis2/gb1/uuid/origin/a/wis2/x/data/y', rules);
		expect(result.override).toBe(true);
		expect(result.reason).toMatch(/topic matches/);
	});

	test('max-length rule matches only when declared length strictly exceeds the ceiling', () => {
		const rules: OverrideRule[] = [{ 'max-length': 100 }];
		expect(evaluateOverride(wnmWithLength(100), 'origin/a/wis2/x/data/y', rules).override).toBe(false); // == is not > 
		expect(evaluateOverride(wnmWithLength(101), 'origin/a/wis2/x/data/y', rules).override).toBe(true);
	});

	test('a max-length rule never matches when the message declares no length', () => {
		const wnm: Wnm = { id: 'm', links: [{ rel: 'canonical', href: 'https://a' }], properties: { pubtime: 't', data_id: 'd' } };
		const rules: OverrideRule[] = [{ 'max-length': 1 }];
		expect(evaluateOverride(wnm, 'origin/a/wis2/x/data/y', rules).override).toBe(false);
	});

	test('a combined topic+max-length rule requires both to match', () => {
		const rules: OverrideRule[] = [{ topic: 'origin/a/wis2/x/data/#', 'max-length': 100 }];
		expect(evaluateOverride(wnmWithLength(50), 'origin/a/wis2/x/data/y', rules).override).toBe(false); // topic matches, size doesn't
		expect(evaluateOverride(wnmWithLength(200), 'origin/a/wis2/other/data/y', rules).override).toBe(false); // size matches, topic doesn't
		expect(evaluateOverride(wnmWithLength(200), 'origin/a/wis2/x/data/y', rules).override).toBe(true);
	});

	test('empty rules (neither topic nor max-length) are ignored, later rules still apply', () => {
		const rules: OverrideRule[] = [{}, { 'max-length': 1 }];
		expect(evaluateOverride(wnmWithLength(10), 'origin/a/wis2/x/data/y', rules).override).toBe(true);
	});

	test('first matching rule wins', () => {
		const rules: OverrideRule[] = [{ topic: 'origin/a/wis2/x/data/#' }, { 'max-length': 1 }];
		const result = evaluateOverride(wnmWithLength(9999), 'origin/a/wis2/x/data/y', rules);
		expect(result.reason).toMatch(/topic matches/);
	});
});
