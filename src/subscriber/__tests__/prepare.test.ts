import { describe, expect, test } from 'bun:test';
import { prepareMessage } from '../prepare.ts';
import type { Wnm } from '../../wis2/wnm.ts';

const wnm = (props: Partial<Wnm['properties']> = {}): Wnm => ({
	id: 'm',
	links: [],
	properties: { pubtime: 't', data_id: 'd', ...props },
});

describe('prepareMessage', () => {
	test('source is "origin" when the topic contains origin, regardless of global-cache property', () => {
		expect(prepareMessage(wnm(), 'origin/a/wis2/x/data/y', false).source).toBe('origin');
	});
	test('source is derived from the global-cache label (stripping "-global-cache") for cache topics', () => {
		expect(prepareMessage(wnm({ 'global-cache': 'fr-meteofrance-global-cache' }), 'cache/a/wis2/x/data/y', false).source).toBe('fr-meteofrance');
	});
	test('source is "unknown" for a cache topic with no global-cache label', () => {
		expect(prepareMessage(wnm(), 'cache/a/wis2/x/data/y', false).source).toBe('unknown');
	});
	// wnm.properties.cache === false alone still sets nocache -- this
	// still gates 'download' vs 'publish-only' (no download + WNM
	// republish) in claim.ts, which the WIS2 Guide requires regardless
	// of source. Only whether the MONITOR event is emitted for this case
	// was deliberately changed -- that's decided in consumer.ts's
	// processEntry, not here. See prepare.ts's header comment.
	test('nocache is true when wnm.properties.cache === false, even without an override', () => {
		expect(prepareMessage(wnm({ cache: false }), 'origin/a/wis2/x/data/y', false).nocache).toBe(true);
	});
	test('nocache is true when overridden, even if cache is not explicitly false', () => {
		expect(prepareMessage(wnm(), 'origin/a/wis2/x/data/y', true).nocache).toBe(true);
	});
	test('nocache is false otherwise', () => {
		expect(prepareMessage(wnm(), 'origin/a/wis2/x/data/y', false).nocache).toBe(false);
	});
});
