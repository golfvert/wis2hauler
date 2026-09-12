import { describe, expect, test } from 'bun:test';
import { aggregateMetrics, type KeyedStats } from '../metrics.ts';

describe('aggregateMetrics', () => {
	test('one combo entry produces a Number/Volume/Delay op and a per-centre Downloaded/Timestamp op', () => {
		const combo: KeyedStats[] = [
			{
				key: '{wis2gc:stats:20260910120000}:combo:centre-1:weather/x/y',
				stats: { count: '3', totalLength: '900', totalDelay: '6000', lastTimestamp: '1757502000' },
			},
		];
		const agg = aggregateMetrics(combo, [], 'my-centre');
		expect(agg.numberOps).toEqual([{ op: 'inc', labels: { centre_id: 'centre-1', topic: 'weather/x/y', report_by: 'my-centre' }, val: 3 }]);
		expect(agg.volumeOps).toEqual([{ op: 'inc', labels: { centre_id: 'centre-1', topic: 'weather/x/y', report_by: 'my-centre' }, val: 900 }]);
		// avgDelay = round(6000/3/1000) = 2
		expect(agg.delayOps).toEqual([{ op: 'set', labels: { centre_id: 'centre-1', topic: 'weather/x/y', report_by: 'my-centre' }, val: 2 }]);
		expect(agg.downloadedOps).toEqual([{ op: 'inc', labels: { centre_id: 'centre-1', report_by: 'my-centre' }, val: 3 }]);
		expect(agg.timestampOps).toEqual([{ op: 'set', labels: { centre_id: 'centre-1', report_by: 'my-centre' }, val: 1757502000 }]);
	});

	test('a missing count yields avgDelay 0 (the guard is `stats.count ? ... : 0`)', () => {
		const combo: KeyedStats[] = [{ key: '{w}:combo:c1:t1', stats: { totalLength: '0' } }];
		const agg = aggregateMetrics(combo, [], 'my-centre');
		expect(agg.delayOps[0]!.val).toBe(0);
		expect(agg.numberOps[0]!.val).toBe(0);
	});

	test('two combos under the same centre_id sum into one Downloaded/Timestamp op (max of lastTimestamp)', () => {
		const combo: KeyedStats[] = [
			{ key: '{w}:combo:centre-1:topic-a', stats: { count: '2', totalLength: '0', totalDelay: '0', lastTimestamp: '100' } },
			{ key: '{w}:combo:centre-1:topic-b', stats: { count: '5', totalLength: '0', totalDelay: '0', lastTimestamp: '300' } },
		];
		const agg = aggregateMetrics(combo, [], 'my-centre');
		expect(agg.downloadedOps).toEqual([{ op: 'inc', labels: { centre_id: 'centre-1', report_by: 'my-centre' }, val: 7 }]);
		expect(agg.timestampOps).toEqual([{ op: 'set', labels: { centre_id: 'centre-1', report_by: 'my-centre' }, val: 300 }]);
	});

	test('a src entry with count > 0 produces a Source op; count 0 or missing produces none', () => {
		const src: KeyedStats[] = [
			{ key: '{w}:src:centre-1:worker-1', stats: { count: '4' } },
			{ key: '{w}:src:centre-1:worker-2', stats: { count: '0' } },
		];
		const agg = aggregateMetrics([], src, 'my-centre');
		expect(agg.sourceOps).toEqual([{ op: 'inc', labels: { centre_id: 'centre-1', source: 'worker-1', report_by: 'my-centre' }, val: 4 }]);
	});

	test('a topic segment containing ":" (joined by slice+join) survives the colon-anchored key parsing', () => {
		const combo: KeyedStats[] = [{ key: '{w}:combo:centre-1:sub:with:colons', stats: { count: '1', totalLength: '0', totalDelay: '0' } }];
		const agg = aggregateMetrics(combo, [], 'my-centre');
		expect(agg.numberOps[0]!.labels.topic).toBe('sub:with:colons');
	});
});
