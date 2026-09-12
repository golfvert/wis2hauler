import { describe, expect, test } from 'bun:test';
import { applyCounterOp, applyGaugeOp, createReporterMetrics } from '../prom.ts';

describe('createReporterMetrics', () => {
	test('registers all 11 metrics under one registry, with names matching flows.json verbatim', async () => {
		const metrics = createReporterMetrics();
		const text = await metrics.registry.metrics();
		const names = [
			'wmo_wis2_gc_integrity_failed_total',
			'wmo_wis2_gc_downloaded_errors_total',
			'monitor_wis2_gc_source_download_total',
			'monitor_wis2_gc_number_download_total',
			'wmo_wis2_gc_downloaded_total',
			'wmo_wis2_gc_last_download_timestamp_seconds',
			'monitor_wis2_gc_delay_download_seconds',
			'monitor_wis2_gc_volume_download_total',
			'wmo_wis2_gc_user_downloaded_files_total',
			'wmo_wis2_gc_user_downloaded_bytes_total',
			'wmo_wis2_gc_user_distinct_total',
		];
		for (const name of names) expect(text).toContain(`# TYPE ${name} `);
	});
});

describe('applyCounterOp / applyGaugeOp', () => {
	test('applyCounterOp calls inc(labels, val) for an inc op', async () => {
		const metrics = createReporterMetrics();
		applyCounterOp(metrics.downloadedTotal, { op: 'inc', labels: { centre_id: 'c1', report_by: 'rb' }, val: 3 });
		const result = await metrics.downloadedTotal.get();
		expect(result.values[0]?.value).toBe(3);
	});

	test('applyCounterOp throws on a "set" op (a real type mismatch, not silently ignored)', () => {
		const metrics = createReporterMetrics();
		expect(() => applyCounterOp(metrics.downloadedTotal, { op: 'set', labels: {}, val: 1 })).toThrow();
	});

	test('applyGaugeOp calls set(labels, val) for a set op', async () => {
		const metrics = createReporterMetrics();
		applyGaugeOp(metrics.userDistinctTotal, { op: 'set', labels: { centre_id: 'c1', topic: 't', user_country: 'US', report_by: 'rb' }, val: 5 });
		const result = await metrics.userDistinctTotal.get();
		expect(result.values[0]?.value).toBe(5);
	});

	test('applyGaugeOp throws on an "inc" op', () => {
		const metrics = createReporterMetrics();
		expect(() => applyGaugeOp(metrics.userDistinctTotal, { op: 'inc', labels: {}, val: 1 })).toThrow();
	});
});
