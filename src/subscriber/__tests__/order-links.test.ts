import { describe, expect, test } from 'bun:test';
import { reorderLinks, classifyTopic, staggerDelaySeconds } from '../order-links.ts';
import type { Wnm } from '../../wis2/wnm.ts';

const baseWnm = (globalCache?: string): Wnm => ({
	id: 'msg-1',
	links: [
		{ rel: 'related', href: 'https://a/related' },
		{ rel: 'update', href: 'https://a/update' },
		{ rel: 'canonical', href: 'https://a/canonical' },
	],
	properties: { pubtime: '2026-09-09T00:00:00Z', data_id: 'urn:x:1', ...(globalCache ? { 'global-cache': globalCache } : {}) },
});

describe('reorderLinks', () => {
	test('moves canonical/update to the front, preserves their relative order and the rest', () => {
		const wnm = baseWnm();
		const reordered = reorderLinks(wnm);
		expect(reordered.links.map((l) => l.rel)).toEqual(['update', 'canonical', 'related']);
	});
});

describe('classifyTopic', () => {
	test('a true origin topic classifies as origin, unstaggered', () => {
		expect(classifyTopic('origin/a/wis2/fr-meteofrance/data/x', baseWnm(), undefined)).toEqual({ kind: 'origin' });
	});
	test('origin classification works through a replay/... wrapper via substring match', () => {
		const topic = 'replay/a/wis2/fr-meteofrance/uuid-1/origin/a/wis2/fr-meteofrance/data/x';
		expect(classifyTopic(topic, baseWnm(), undefined)).toEqual({ kind: 'origin' });
	});
	test('a cache topic with no priority list configured is unstaggered', () => {
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', baseWnm('fr-meteofrance-global-cache'), undefined))
			.toEqual({ kind: 'cache-unprioritized' });
	});
	test('a cache topic with a matching priority position gets that position', () => {
		const wnm = baseWnm('gb2-global-cache');
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, ['gb1-global-cache', 'gb2-global-cache']))
			.toEqual({ kind: 'cache', position: 1 });
	});
	test('a cache topic whose global-cache label is not in the priority list is ignored', () => {
		const wnm = baseWnm('unknown-global-cache');
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, ['gb1-global-cache'])).toEqual({ kind: 'ignore' });
	});
	test('priority-global-cache is unbounded in length (2026-09-15): a 9th+ entry still classifies as cache, not ignore', () => {
		const centres = Array.from({ length: 12 }, (_, i) => `gb${i}-global-cache`);
		const wnm = baseWnm('gb11-global-cache');
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, centres)).toEqual({ kind: 'cache', position: 11 });
	});
	test('a cache topic with no global-cache property at all is ignored (priority list configured)', () => {
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', baseWnm(), ['gb1-global-cache'])).toEqual({ kind: 'ignore' });
	});
	test('neither origin nor cache -> ignored', () => {
		expect(classifyTopic('monitor/a/wis2/fr-meteofrance/x', baseWnm(), undefined)).toEqual({ kind: 'ignore' });
	});
});

describe('staggerDelaySeconds', () => {
	test('origin and cache-unprioritized are unstaggered', () => {
		expect(staggerDelaySeconds({ kind: 'origin' })).toBe(0);
		expect(staggerDelaySeconds({ kind: 'cache-unprioritized' })).toBe(0);
	});
	test('cache position maps through the stagger table, positions 0 and 1 both 1s', () => {
		expect(staggerDelaySeconds({ kind: 'cache', position: 0 })).toBe(1);
		expect(staggerDelaySeconds({ kind: 'cache', position: 1 })).toBe(1);
		expect(staggerDelaySeconds({ kind: 'cache', position: 2 })).toBe(3);
		expect(staggerDelaySeconds({ kind: 'cache', position: 7 })).toBe(8);
	});
	test('positions past the 8-slot table (2026-09-15: priority-global-cache no longer capped) continue the +1s-per-position progression', () => {
		expect(staggerDelaySeconds({ kind: 'cache', position: 8 })).toBe(9);
		expect(staggerDelaySeconds({ kind: 'cache', position: 9 })).toBe(10);
		expect(staggerDelaySeconds({ kind: 'cache', position: 30 })).toBe(31);
	});
});
