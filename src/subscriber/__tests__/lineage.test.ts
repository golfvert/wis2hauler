import { describe, expect, test } from 'bun:test';
import { decideLineage, hasUpdateRel } from '../lineage.ts';
import type { Wnm } from '../../wis2/wnm.ts';

describe('hasUpdateRel', () => {
	test('true when any link has rel "update"', () => {
		const wnm: Wnm = { id: 'x', links: [{ rel: 'canonical', href: 'a' }, { rel: 'update', href: 'b' }], properties: { pubtime: 't', data_id: 'd' } };
		expect(hasUpdateRel(wnm)).toBe(true);
	});

	test('false when every link is canonical (or anything else)', () => {
		const wnm: Wnm = { id: 'x', links: [{ rel: 'canonical', href: 'a' }], properties: { pubtime: 't', data_id: 'd' } };
		expect(hasUpdateRel(wnm)).toBe(false);
	});

	test('false with no links at all', () => {
		const wnm: Wnm = { id: 'x', links: [], properties: { pubtime: 't', data_id: 'd' } };
		expect(hasUpdateRel(wnm)).toBe(false);
	});
});

describe('decideLineage', () => {
	test('first time seeing this data_id -> new, regardless of rel', () => {
		expect(decideLineage('2026-01-01T00:00:00Z', false, [])).toEqual({ kind: 'new' });
		expect(decideLineage('2026-01-01T00:00:00Z', true, [])).toEqual({ kind: 'new' });
	});

	// Reproduces the real ca-eccc-msc case the maintainer found via the
	// Sensor Global Cache tool: same data_id, same pubtime, rel=canonical
	// both times.
	test('same pubtime as a known one, rel=canonical -> duplicate', () => {
		const decision = decideLineage('2026-01-01T00:00:00Z', false, ['2026-01-01T00:00:00Z']);
		expect(decision.kind).toBe('duplicate');
		expect((decision as { reason: string }).reason).toMatch(/not newer/);
	});

	test('an OLDER pubtime than a known one -> duplicate, even with rel=update', () => {
		const decision = decideLineage('2025-12-31T00:00:00Z', true, ['2026-01-01T00:00:00Z']);
		expect(decision.kind).toBe('duplicate');
	});

	test('a strictly newer pubtime but rel is still canonical (not update) -> duplicate', () => {
		const decision = decideLineage('2026-01-02T00:00:00Z', false, ['2026-01-01T00:00:00Z']);
		expect(decision.kind).toBe('duplicate');
		expect((decision as { reason: string }).reason).toMatch(/rel is not "update"/);
	});

	test('a strictly newer pubtime with rel=update -> update (accepted)', () => {
		const decision = decideLineage('2026-01-02T00:00:00Z', true, ['2026-01-01T00:00:00Z']);
		expect(decision).toEqual({ kind: 'update' });
	});

	test('must be newer than EVERY known pubtime, not just the latest one seen -- order of knownPubtimes must not matter', () => {
		// Out-of-order on purpose: '2026-01-03' arrived (and was recorded)
		// before '2026-01-02' in this history.
		const known = ['2026-01-03T00:00:00Z', '2026-01-01T00:00:00Z'];
		// Newer than both -> update.
		expect(decideLineage('2026-01-04T00:00:00Z', true, known)).toEqual({ kind: 'update' });
		// Newer than one but not the other -> still a duplicate.
		const decision = decideLineage('2026-01-02T00:00:00Z', true, known);
		expect(decision.kind).toBe('duplicate');
	});
});
