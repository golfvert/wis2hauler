// The Reporter tab's 11 "prometheus-metric-config" nodes -- ported
// using the prom-client npm package rather than hand-rolling the
// exposition format (an original engineering choice, same category as
// the Reporter's other "kept, not replaced" library decisions in this
// project -- not a guess about flows.json semantics, since name/help/
// labels/type below are taken verbatim from each config node).
//
// Every op this Reporter port ever builds (hash-error.ts, metrics.ts,
// caddy.ts) is EITHER always "inc" or always "set" for a given metric
// -- matches each node's own mtype (counter -> inc-only, gauge ->
// set-only) exactly, confirmed by reading every "op" literal in the
// original's change nodes; applyCounterOp/applyGaugeOp below assert
// that pairing rather than silently tolerating a mismatch.
import { Counter, Gauge, Registry } from 'prom-client';
import type { MetricOp } from './hash-error.ts';

export interface ReporterMetrics {
	registry: Registry;
	/** wmo_wis2_gc_integrity_failed_total (be8bb278185f55ef... wait, e334fa93f70afdfd is Hash/integrity, be8bb278185f55ef is Error/downloaded_errors -- see field names below). */
	integrityFailedTotal: Counter<string>;
	downloadedErrorsTotal: Counter<string>;
	sourceDownloadTotal: Counter<string>;
	numberDownloadTotal: Counter<string>;
	downloadedTotal: Counter<string>;
	lastDownloadTimestampSeconds: Gauge<string>;
	delayDownloadSeconds: Gauge<string>;
	volumeDownloadTotal: Counter<string>;
	userDownloadedFilesTotal: Counter<string>;
	userDownloadedBytesTotal: Counter<string>;
	userDistinctTotal: Gauge<string>;
}

export function createReporterMetrics(): ReporterMetrics {
	const registry = new Registry();

	// "Hash" prometheus-exporter (343ec55594149861), config e334fa93f70afdfd.
	const integrityFailedTotal = new Counter({
		name: 'wmo_wis2_gc_integrity_failed_total',
		help: 'Total number of messages that failed the integrity check',
		labelNames: ['centre_id', 'report_by'],
		registers: [registry],
	});

	// "Error" prometheus-exporter (18421357db3ddac5), config be8bb278185f55ef.
	const downloadedErrorsTotal = new Counter({
		name: 'wmo_wis2_gc_downloaded_errors_total',
		help: 'Total number of file download errors',
		labelNames: ['centre_id', 'report_by'],
		registers: [registry],
	});

	// "Source" prometheus-exporter (05cb5922ea25daf9), config b6eaa80da4be2167.
	const sourceDownloadTotal = new Counter({
		name: 'monitor_wis2_gc_source_download_total',
		help: 'Number of files successfully downloaded per source',
		labelNames: ['centre_id', 'source', 'report_by'],
		registers: [registry],
	});

	// "Number" prometheus-exporter (c99c758c05d58fe6), config 833dd9f884cd3f43.
	const numberDownloadTotal = new Counter({
		name: 'monitor_wis2_gc_number_download_total',
		help: 'Number of downloaded files',
		labelNames: ['centre_id', 'topic', 'report_by'],
		registers: [registry],
	});

	// "Downloaded" prometheus-exporter (f2914324c9dc9527), config d265551416fe184b.
	const downloadedTotal = new Counter({
		name: 'wmo_wis2_gc_downloaded_total',
		help: 'Total number of files downloaded by the Global Cache',
		labelNames: ['centre_id', 'report_by'],
		registers: [registry],
	});

	// "Timestamp" prometheus-exporter (01e162b7a068107d), config e2c731c0b72b7626.
	const lastDownloadTimestampSeconds = new Gauge({
		name: 'wmo_wis2_gc_last_download_timestamp_seconds',
		help: 'Timestamp (Unix seconds) of the last successful file download',
		labelNames: ['centre_id', 'report_by'],
		registers: [registry],
	});

	// "Delay" prometheus-exporter (41789583be323001), config f2a2a080e159b3a2.
	const delayDownloadSeconds = new Gauge({
		name: 'monitor_wis2_gc_delay_download_seconds',
		help: 'Delay to download files',
		labelNames: ['centre_id', 'topic', 'report_by'],
		registers: [registry],
	});

	// "Volume" prometheus-exporter (b33f448a366ba16a), config 0b1738558640a231.
	const volumeDownloadTotal = new Counter({
		name: 'monitor_wis2_gc_volume_download_total',
		help: 'Volume of downloaded files',
		labelNames: ['centre_id', 'topic', 'report_by'],
		registers: [registry],
	});

	// "Files" prometheus-exporter (574c0c85b55c6c0c), config ba17e8e642f4bccf.
	const userDownloadedFilesTotal = new Counter({
		name: 'wmo_wis2_gc_user_downloaded_files_total',
		help: 'Number of files downloaded successfully from the GC',
		labelNames: ['user_country', 'topic', 'centre_id', 'report_by'],
		registers: [registry],
	});

	// "Bytes" prometheus-exporter (a9892db888f16568), config c1611583656f72ef.
	const userDownloadedBytesTotal = new Counter({
		name: 'wmo_wis2_gc_user_downloaded_bytes_total',
		help: 'Size of data downloaded successfully from the GC',
		labelNames: ['user_country', 'topic', 'centre_id', 'report_by'],
		registers: [registry],
	});

	// "IPs" prometheus-exporter (2f51ef9ea41efc14), config 2a50623415138162.
	const userDistinctTotal = new Gauge({
		name: 'wmo_wis2_gc_user_distinct_total',
		help: 'Number of distinct users (as distinguished by their IP address) having downloaded data.',
		labelNames: ['user_country', 'topic', 'centre_id', 'report_by'],
		registers: [registry],
	});

	return {
		registry,
		integrityFailedTotal,
		downloadedErrorsTotal,
		sourceDownloadTotal,
		numberDownloadTotal,
		downloadedTotal,
		lastDownloadTimestampSeconds,
		delayDownloadSeconds,
		volumeDownloadTotal,
		userDownloadedFilesTotal,
		userDownloadedBytesTotal,
		userDistinctTotal,
	};
}

export interface Incrementable {
	inc(labels: Record<string, string>, value: number): void;
}
export interface Settable {
	set(labels: Record<string, string>, value: number): void;
}

export function applyCounterOp(metric: Incrementable, op: MetricOp): void {
	if (op.op !== 'inc') throw new Error(`applyCounterOp: expected an "inc" op, got "${op.op}"`);
	metric.inc(op.labels, op.val);
}

export function applyGaugeOp(metric: Settable, op: MetricOp): void {
	if (op.op !== 'set') throw new Error(`applyGaugeOp: expected a "set" op, got "${op.op}"`);
	metric.set(op.labels, op.val);
}
