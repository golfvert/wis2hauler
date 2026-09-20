import { describe, expect, test } from 'bun:test';
import { reorderLinks, classifyTopic, resolveWeight, computeDelaySeconds } from '../order-links.ts';
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

describe('resolveWeight', () => {
	test('weightSources undefined -> every key gets weight 1', () => {
		expect(resolveWeight('origin', undefined)).toBe(1);
		expect(resolveWeight('de-dwd-global-cache', undefined)).toBe(1);
		expect(resolveWeight('anything-at-all', undefined)).toBe(1);
	});

	test('weightSources present -> a listed key returns its configured weight', () => {
		const weightSources = new Map([
			['origin', 1],
			['de-dwd-global-cache', 0.2],
		]);
		expect(resolveWeight('origin', weightSources)).toBe(1);
		expect(resolveWeight('de-dwd-global-cache', weightSources)).toBe(0.2);
	});

	test('weightSources present -> a key NOT listed (including "origin") defaults to weight 0', () => {
		const weightSources = new Map([['de-dwd-global-cache', 0.2]]);
		expect(resolveWeight('origin', weightSources)).toBe(0);
		expect(resolveWeight('unknown-global-cache', weightSources)).toBe(0);
	});
});

describe('classifyTopic', () => {
	test('a true origin topic classifies as origin, weight 1 with no weight-sources configured', () => {
		expect(classifyTopic('origin/a/wis2/fr-meteofrance/data/x', baseWnm(), undefined)).toEqual({ kind: 'origin', weight: 1 });
	});

	test('origin classification works through a replay/... wrapper via substring match', () => {
		const topic = 'replay/a/wis2/fr-meteofrance/uuid-1/origin/a/wis2/fr-meteofrance/data/x';
		expect(classifyTopic(topic, baseWnm(), undefined)).toEqual({ kind: 'origin', weight: 1 });
	});

	test('a cache topic with no weight-sources configured gets weight 1 (same default as origin)', () => {
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', baseWnm('fr-meteofrance-global-cache'), undefined)).toEqual({
			kind: 'cache',
			weight: 1,
		});
	});

	test('a cache topic with an explicit configured weight gets that weight', () => {
		const wnm = baseWnm('de-dwd-global-cache');
		const weightSources = new Map([
			['origin', 1],
			['de-dwd-global-cache', 0.2],
		]);
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, weightSources)).toEqual({ kind: 'cache', weight: 0.2 });
	});

	test('a cache topic whose global-cache label is not in a configured weight-sources map resolves to weight 0 -> ignored', () => {
		const wnm = baseWnm('unknown-global-cache');
		const weightSources = new Map([['origin', 1], ['gb1-global-cache', 1]]);
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, weightSources)).toEqual({ kind: 'ignore' });
	});

	test('an origin topic with weight-sources configured but no "origin" key resolves to weight 0 -> ignored', () => {
		const weightSources = new Map([['de-dwd-global-cache', 1]]);
		expect(classifyTopic('origin/a/wis2/fr-meteofrance/data/x', baseWnm(), weightSources)).toEqual({ kind: 'ignore' });
	});

	test('a cache topic with no global-cache property at all is ignored regardless of weight-sources', () => {
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', baseWnm(), undefined)).toEqual({ kind: 'ignore' });
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', baseWnm(), new Map([['gb1-global-cache', 1]]))).toEqual({ kind: 'ignore' });
	});

	test('a source explicitly weighted to 0 is ignored even though it IS listed', () => {
		const wnm = baseWnm('de-dwd-global-cache');
		const weightSources = new Map([
			['origin', 1],
			['de-dwd-global-cache', 0],
		]);
		expect(classifyTopic('cache/a/wis2/fr-meteofrance/data/x', wnm, weightSources)).toEqual({ kind: 'ignore' });
	});

	test('neither origin nor cache -> ignored', () => {
		expect(classifyTopic('monitor/a/wis2/fr-meteofrance/x', baseWnm(), undefined)).toEqual({ kind: 'ignore' });
	});
});

describe('computeDelaySeconds', () => {
	// Infinity -- i.e. "no cap" -- for every test below that isn't
	// specifically exercising maxDelaySeconds, so the cap can't
	// accidentally interfere with a test about the raw formula.
	const NO_CAP = Number.POSITIVE_INFINITY;

	test('an "ignore" classification is never delayed', () => {
		expect(computeDelaySeconds({ kind: 'ignore' }, 8, NO_CAP, () => 0.5)).toBe(0);
	});

	test('implements -ln(random) * (weightDelaySeconds / weight)', () => {
		// -ln(e^-1) = 1, so with weightDelaySeconds=8 and weight=2 the delay is 1 * (8/2) = 4s.
		const random = () => Math.exp(-1);
		expect(computeDelaySeconds({ kind: 'cache', weight: 2 }, 8, NO_CAP, random)).toBeCloseTo(4, 10);
		expect(computeDelaySeconds({ kind: 'origin', weight: 1 }, 8, NO_CAP, random)).toBeCloseTo(8, 10);
	});

	test('a higher weight yields a smaller delay for the same random draw', () => {
		const random = () => 0.3;
		const low = computeDelaySeconds({ kind: 'cache', weight: 1 }, 8, NO_CAP, random);
		const high = computeDelaySeconds({ kind: 'cache', weight: 4 }, 8, NO_CAP, random);
		expect(high).toBeLessThan(low);
		expect(high).toBeCloseTo(low / 4, 10);
	});

	test('weightDelaySeconds of 0 always yields a 0 delay, regardless of weight or random', () => {
		expect(computeDelaySeconds({ kind: 'origin', weight: 1 }, 0, NO_CAP, () => 0.01)).toBe(0);
		expect(computeDelaySeconds({ kind: 'cache', weight: 0.2 }, 0, NO_CAP, () => 0.99)).toBe(0);
	});

	// classifyTopic never actually returns a weight <= 0 classification
	// (it resolves straight to 'ignore' instead -- see classifyTopic's own
	// tests above), but computeDelaySeconds guards against it directly
	// anyway rather than risking a divide-by-zero/Infinity sleep.
	test('a non-positive weight short-circuits to 0 rather than dividing by zero', () => {
		expect(computeDelaySeconds({ kind: 'cache', weight: 0 }, 8, NO_CAP, () => 0.5)).toBe(0);
	});

	// maxDelaySeconds -- added 2026-09-20 after a production incident (see
	// this function's own doc comment): a plain truncation of the raw
	// exponential draw, applied regardless of weight.
	describe('maxDelaySeconds (hard cap)', () => {
		test('a raw draw below the cap is returned unchanged', () => {
			const random = () => Math.exp(-1); // -ln(e^-1) = 1 -> raw = 1 * (10/1) = 10s
			expect(computeDelaySeconds({ kind: 'origin', weight: 1 }, 10, 120, random)).toBeCloseTo(10, 10);
		});

		test('a raw draw above the cap is clipped to exactly the cap', () => {
			// -ln(0.0001) ≈ 9.21, so raw = 9.21 * (10/0.2) ≈ 460.5s -- far past a 120s cap.
			const random = () => 0.0001;
			expect(computeDelaySeconds({ kind: 'cache', weight: 0.2 }, 10, 120, random)).toBe(120);
		});

		test('a raw draw exactly at the cap is unaffected', () => {
			// Choose random() so raw lands exactly on the cap: raw = -ln(U) * (mu) = cap
			// -> U = e^(-cap/mu). mu = weightDelaySeconds/weight = 10/1 = 10, cap = 20 -> U = e^-2.
			const random = () => Math.exp(-2);
			expect(computeDelaySeconds({ kind: 'origin', weight: 1 }, 10, 20, random)).toBeCloseTo(20, 10);
		});

		// Percentile math from this function's own doc comment: for an
		// exponential with mean mu, P(delay > x) = e^(-x/mu). With
		// weightDelaySeconds=5.2 and weight=0.2 (mu=26s), the 90th
		// percentile should sit right around 60s -- i.e. roughly 90% of
		// (uncapped) draws land at or below 60s, statistically.
		test('choosing weightDelaySeconds via the P90 formula lands the 90th percentile near the target (statistical, real randomness)', () => {
			const weight = 0.2;
			const targetP90 = 60;
			// mu = target / ln(1/(1-p)), p=0.9 -> ln(10)
			const mu = targetP90 / Math.log(10);
			const weightDelaySeconds = mu * weight; // ≈ 5.2
			const cap = 120; // comfortably above targetP90, per the doc comment's guidance

			const trials = 5000;
			let underTarget = 0;
			for (let i = 0; i < trials; i++) {
				const delay = computeDelaySeconds({ kind: 'cache', weight }, weightDelaySeconds, cap, Math.random);
				if (delay <= targetP90) underTarget++;
				expect(delay).toBeLessThanOrEqual(cap); // the hard cap must never be exceeded
			}
			const share = underTarget / trials;
			// Expected ~0.90 -- generous tolerance against statistical variance.
			expect(share).toBeGreaterThan(0.85);
			expect(share).toBeLessThan(0.95);
		});
	});

	// Statistical check of the core claim behind this mechanism: across
	// many independent trials, each drawing its own exponential delay,
	// the candidate whose delay elapses first (the "winner") wins
	// proportionally to its share of total weight -- with no
	// cross-candidate coordination. Uses the real Math.random (not
	// injected) since this is deliberately testing the actual
	// distribution, not a fixed formula input.
	test('win-share across many trials tracks weight ratio (statistical, real randomness)', () => {
		const weights: Record<string, number> = { a: 1, b: 3 }; // b should win ~75% of the time
		const trials = 4000;
		let aWins = 0;
		let bWins = 0;
		for (let i = 0; i < trials; i++) {
			const delayA = computeDelaySeconds({ kind: 'cache', weight: weights.a! }, 1, NO_CAP, Math.random);
			const delayB = computeDelaySeconds({ kind: 'cache', weight: weights.b! }, 1, NO_CAP, Math.random);
			if (delayA < delayB) aWins++;
			else bWins++;
		}
		const bShare = bWins / trials;
		// Expected 0.75 -- allow a generous tolerance to keep this from
		// flaking under normal statistical variance at 4000 trials.
		expect(bShare).toBeGreaterThan(0.68);
		expect(bShare).toBeLessThan(0.82);
		expect(aWins + bWins).toBe(trials);
	});
});
