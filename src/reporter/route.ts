// The Reporter tab's "Type ?" switch (7c9b8e862cac33e8) -- ported
// field-for-field: checkall:false, so the FIRST matching rule wins,
// in this exact order ('integrity_fail', then 'download_error', then
// else).
export type ReportKind = 'integrity_fail' | 'download_error' | 'download_failed' | 'stats';

export function classifyReportType(type: unknown): ReportKind {
	if (type === 'integrity_fail') return 'integrity_fail';
	if (type === 'download_error') return 'download_error';
	// NOT in the original: sent once when a download's retries are exhausted, for the `failed` line.
	if (type === 'download_failed') return 'download_failed';
	return 'stats';
}
