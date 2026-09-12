// The Reporter tab's "Hash" (6feb253b0a352b41) and "Error"
// (a02bcc4a5d7904d0) change nodes -- both build an identically-shaped
// Prometheus counter-increment op from `$split(wnmtopic,"/")[3]`.
//
// BUG FOUND AND FIXED (the maintainer's explicit decision, asked via
// AskUserQuestion this session -- "Fix: use payload.topic"): at this
// point in the Reporter tab's graph, `msg` only carries `payload`
// (the "K/V" function's output object, `{type, topic, ...}` for these
// two branches) and `topic` (the pubsub channel name) -- there is no
// `msg.wnmtopic` anywhere on this chain (that field only exists on
// Downloader-tab messages, a separate Node-RED process/tab entirely).
// The literal flows.json behavior is therefore centre_id=undefined
// for BOTH `wmo_wis2_gc_integrity_failed_total` and
// `wmo_wis2_gc_downloaded_errors_total`, always -- a real bug, not a
// misreading. Confirmed against the record's actual producers
// (error-retry.ts's reportBadHash/reportDownloadError, which publish
// `["type","integrity_fail","topic",wnmTopic]` / `["type",
// "download_error","topic",wnmTopic]`): the value the original surely
// intended is sitting right there as `payload.topic` (this record's
// own `raw.topic` after kv.ts's transformKV), so that's what this port
// uses instead of the nonexistent `wnmtopic`.
export interface MetricOp {
	op: 'inc' | 'set';
	labels: Record<string, string>;
	val: number;
}

/** `topic`: the KVRecord's own raw.topic field (was: the nonexistent wnmtopic -- see header). `reportBy`: global "centre-id". */
export function buildHashOrErrorOp(topic: string | undefined, reportBy: string): MetricOp {
	const parts = (topic ?? '').split('/');
	return {
		op: 'inc',
		labels: { centre_id: parts[3] ?? '', report_by: reportBy },
		val: 1,
	};
}
