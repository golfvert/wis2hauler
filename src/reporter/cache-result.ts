// What REPORTER logs for every notification SUBSCRIBER accepted for
// download, as one line in `hauler-reporter-*.info.log`:
//
//   cached  completed within global.cache-deadline
//   late    completed, but after the deadline
//   failed  retries exhausted (DOWNLOADER sends a `download_failed` report)
//   missed  the deadline marker expired: neither completed nor failed
//
// These builders are pure: they turn a flat Redis record (the
// downloader_id hash, or a report that carries it) into the fields of
// the line. They never throw on a partial record -- a missing field is
// simply absent from the line.

export type CacheStatus = 'cached' | 'late' | 'failed' | 'missed';

export interface CacheResult {
	status: CacheStatus;
	fields: Record<string, unknown>;
}

const HREF_STATES = /^(queue|wait|error|complete)$/;

function toRecord(flat: readonly unknown[]): Record<string, string> {
	const rec: Record<string, string> = {};
	for (let i = 0; i < flat.length; i += 2) rec[String(flat[i])] = String(flat[i + 1] ?? '');
	return rec;
}

function num(value: string | undefined): number | undefined {
	if (value === undefined || value === '') return undefined;
	const n = Number(value);
	return Number.isFinite(n) ? n : undefined;
}

function iso(ms: number | undefined): string | undefined {
	return ms === undefined ? undefined : new Date(ms).toISOString();
}

/** The stored `wnm` field is the received notification plus the internal `downloader_id` added by SUBSCRIBER. */
function parseWnm(raw: string | undefined): { wnm?: Record<string, unknown>; downloaderId?: string } {
	if (!raw) return {};
	try {
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
		const { downloader_id, ...wnm } = parsed as Record<string, unknown>;
		return { wnm, downloaderId: typeof downloader_id === 'string' ? downloader_id : undefined };
	} catch {
		return {};
	}
}

function hrefOf(rec: Record<string, string>): string | undefined {
	for (const [key, value] of Object.entries(rec)) {
		if (!key.startsWith('src:') && HREF_STATES.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(key)) return key;
	}
	return undefined;
}

function dataIdOf(rec: Record<string, string>, wnm: Record<string, unknown> | undefined): string | undefined {
	if (rec.data_id) return rec.data_id;
	const props = wnm?.properties as Record<string, unknown> | undefined;
	return typeof props?.data_id === 'string' ? props.data_id : undefined;
}

function common(rec: Record<string, string>, downloaderId: string | undefined, wnm: Record<string, unknown> | undefined): Record<string, unknown> {
	return {
		data_id: dataIdOf(rec, wnm),
		downloader_id: downloaderId,
		wnm_id: typeof wnm?.id === 'string' ? wnm.id : undefined,
		pubtime: rec.published || undefined,
		topic: rec.topic || undefined,
		href: hrefOf(rec),
		acceptedAt: iso(num(rec.accepted)),
		wnm,
	};
}

/** The completion report DOWNLOADER sends (`[...downloader_id hash, 'length', n]`): `cached`, or `late` past the deadline. */
export function buildCompletionResult(flat: readonly unknown[], deadlineMs: number): CacheResult | null {
	const rec = toRecord(flat);
	const { wnm, downloaderId } = parseWnm(rec.wnm);
	if (!wnm && !rec.data_id) return null;
	const accepted = num(rec.accepted);
	const stored = num(rec.stored);
	const latencyMs = accepted !== undefined && stored !== undefined ? stored - accepted : undefined;
	const late = latencyMs !== undefined && latencyMs > deadlineMs;
	return {
		status: late ? 'late' : 'cached',
		fields: {
			...common(rec, downloaderId ?? (rec.downloader_id || undefined), wnm),
			cachedAt: iso(stored),
			latencyMs,
			length: num(rec.length),
			...(late ? { deadlineMs } : {}),
		},
	};
}

/** The one-off `download_failed` report sent when retries are exhausted. */
export function buildFailedResult(flat: readonly unknown[]): CacheResult {
	const rec = toRecord(flat);
	const { wnm } = parseWnm(rec.wnm);
	return {
		status: 'failed',
		fields: {
			...common(rec, rec.downloader_id || undefined, wnm),
			failedAt: iso(num(rec.failed_at)),
			reason: rec.reason || undefined,
			attempt: rec.attempt || undefined,
		},
	};
}

/** True when the downloader_id hash already shows a completed href: a marker that expires then is not a miss. */
export function isCompleted(flat: readonly unknown[]): boolean {
	return Object.values(toRecord(flat)).some((value) => value === 'complete');
}

/** The deadline marker for `downloaderId` expired. `flat` is its downloader_id hash (empty when it has since gone). */
export function buildMissedResult(downloaderId: string, flat: readonly unknown[], deadlineMs: number): CacheResult {
	const rec = toRecord(flat);
	const { wnm } = parseWnm(rec.wnm);
	return {
		status: 'missed',
		fields: {
			...common(rec, downloaderId, wnm),
			deadlineMs,
			attempt: rec.attempt || undefined,
		},
	};
}
