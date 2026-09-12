// The Reporter tab's "Metrics" function node (24ddb5fcccf4e13b) --
// ported field-for-field. Fed by "HashStat" (window.ts) through the
// "Reporter ?" gate (9bf83f610940c63a, see run.ts) with msg.payload =
// the PREVIOUS 30s window's key (the window that just closed).
//
// Reads that window's {windowKey}:total (HGETALL -- fetched but, per
// the original, its result is NEVER actually used for anything below;
// preserved as a real fetch in the real store for fidelity, but this
// pure function doesn't take it as an input since it has no effect on
// any output), {windowKey}:combo:* and {windowKey}:src:* (KEYS, then
// HGETALL each), and turns them into up to 6 groups of Prometheus ops
// (the original's outputs 1-6; output 7 is unwired in flows.json --
// there is no 7th op group here).
//
// Key parsing (`key.split(':')`, then `indexOf('combo')`/`indexOf('src')`
// to anchor) is ported literally, including its byproduct: it's blind
// to the windowKey's own embedded colons ("wis2gc:stats:...") because
// it anchors on the LITERAL "combo"/"src" segment, not a fixed index.
import type { MetricOp } from './hash-error.ts';

export interface KeyedStats {
	/** The full Redis key as returned by KEYS (still carrying its `{windowKey}` hash-tag wrapper). */
	key: string;
	stats: Record<string, string>;
}

export interface AggregatedMetrics {
	/** monitor_wis2_gc_number_download_total -- one inc per combo (centre_id, topic). */
	numberOps: MetricOp[];
	/** monitor_wis2_gc_volume_download_total -- one inc per combo. */
	volumeOps: MetricOp[];
	/** monitor_wis2_gc_delay_download_seconds -- one set per combo. */
	delayOps: MetricOp[];
	/** monitor_wis2_gc_source_download_total -- one inc per (centre_id, source), only when count > 0. */
	sourceOps: MetricOp[];
	/** wmo_wis2_gc_downloaded_total -- one inc per centre_id, summed across that centre's combos. */
	downloadedOps: MetricOp[];
	/** wmo_wis2_gc_last_download_timestamp_seconds -- one set per centre_id, the max lastTimestamp across that centre's combos. */
	timestampOps: MetricOp[];
}

export function aggregateMetrics(comboEntries: readonly KeyedStats[], srcEntries: readonly KeyedStats[], reportBy: string): AggregatedMetrics {
	const numberOps: MetricOp[] = [];
	const volumeOps: MetricOp[] = [];
	const delayOps: MetricOp[] = [];

	for (const { key, stats } of comboEntries) {
		const parts = key.split(':');
		const comboIndex = parts.indexOf('combo');
		const centreId = parts[comboIndex + 1] ?? '';
		const topic = parts.slice(comboIndex + 2).join(':');

		const count = parseInt(stats.count ?? '', 10) || 0;
		const totalLength = parseInt(stats.totalLength ?? '', 10) || 0;
		const avgDelay = stats.count ? Math.round(parseInt(stats.totalDelay ?? '', 10) / parseInt(stats.count, 10) / 1000) : 0;

		numberOps.push({ op: 'inc', labels: { centre_id: centreId, topic, report_by: reportBy }, val: count });
		volumeOps.push({ op: 'inc', labels: { centre_id: centreId, topic, report_by: reportBy }, val: totalLength });
		delayOps.push({ op: 'set', labels: { centre_id: centreId, topic, report_by: reportBy }, val: avgDelay });
	}

	const sourceOps: MetricOp[] = [];
	for (const { key, stats } of srcEntries) {
		const parts = key.split(':');
		const srcIndex = parts.indexOf('src');
		const centreId = parts[srcIndex + 1] ?? '';
		const source = parts.slice(srcIndex + 2).join(':');
		const count = parseInt(stats.count ?? '', 10) || 0;
		if (count > 0) sourceOps.push({ op: 'inc', labels: { centre_id: centreId, source, report_by: reportBy }, val: count });
	}

	const perCentre = new Map<string, { count: number; lastTimestamp: number }>();
	for (const { key, stats } of comboEntries) {
		const parts = key.split(':');
		const comboIndex = parts.indexOf('combo');
		const centreId = parts[comboIndex + 1] ?? '';
		const agg = perCentre.get(centreId) ?? { count: 0, lastTimestamp: 0 };
		agg.count += parseInt(stats.count ?? '', 10) || 0;
		agg.lastTimestamp = Math.max(agg.lastTimestamp, parseInt(stats.lastTimestamp ?? '', 10) || 0);
		perCentre.set(centreId, agg);
	}

	const downloadedOps: MetricOp[] = [];
	const timestampOps: MetricOp[] = [];
	for (const [centreId, agg] of perCentre) {
		downloadedOps.push({ op: 'inc', labels: { centre_id: centreId, report_by: reportBy }, val: agg.count });
		timestampOps.push({ op: 'set', labels: { centre_id: centreId, report_by: reportBy }, val: agg.lastTimestamp });
	}

	return { numberOps, volumeOps, delayOps, sourceOps, downloadedOps, timestampOps };
}
