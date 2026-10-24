import { describe, expect, test } from 'bun:test';
import { buildCompletionResult, buildFailedResult, buildMissedResult, isCompleted } from '../cache-result.ts';

const DEADLINE = 600_000;
const HREF = 'https://dcpc.example/data/x.bufr4';
const WNM = {
	id: 'wnm-1',
	downloader_id: 'wis2:centre:abc',
	links: [{ rel: 'canonical', href: HREF }],
	properties: { data_id: 'data-1', pubtime: '2026-10-24T07:50:02Z' },
	type: 'Feature',
};

/** A downloader_id hash as it is when the download completes (LUA_COMPLETE), flattened. */
function completedHash(accepted: number, stored: number): string[] {
	return [
		HREF, 'complete',
		`src:${HREF}`, 'origin',
		'wnm', JSON.stringify(WNM),
		'topic', 'origin/a/wis2/fr-meteofrance/data/core/weather/surface-based-observations/synop',
		'published', '2026-10-24T07:50:02Z',
		'attempt', '1',
		'data_id', 'data-1',
		'accepted', String(accepted),
		'stored', String(stored),
		'link', 'https://local/x.bufr4',
		'local-path', 'x.bufr4',
	];
}

describe('buildCompletionResult', () => {
	test('a completion inside the deadline is `cached`, with latency, ids, href and the received WNM', () => {
		const accepted = Date.parse('2026-10-24T07:50:03.412Z');
		const result = buildCompletionResult([...completedHash(accepted, accepted + 6462), 'length', '18342'], DEADLINE)!;

		expect(result.status).toBe('cached');
		expect(result.fields).toMatchObject({
			data_id: 'data-1',
			downloader_id: 'wis2:centre:abc',
			wnm_id: 'wnm-1',
			pubtime: '2026-10-24T07:50:02Z',
			href: HREF,
			acceptedAt: '2026-10-24T07:50:03.412Z',
			cachedAt: '2026-10-24T07:50:09.874Z',
			latencyMs: 6462,
			length: 18342,
		});
		expect(result.fields.deadlineMs).toBeUndefined();
	});

	test('the logged WNM is the received one: the internal downloader_id field is removed', () => {
		const result = buildCompletionResult(completedHash(1000, 2000), DEADLINE)!;
		expect(result.fields.wnm).toEqual({
			id: 'wnm-1',
			links: [{ rel: 'canonical', href: HREF }],
			properties: { data_id: 'data-1', pubtime: '2026-10-24T07:50:02Z' },
			type: 'Feature',
		});
	});

	test('a completion after the deadline is `late` and carries deadlineMs', () => {
		const result = buildCompletionResult(completedHash(1_000_000, 1_000_000 + DEADLINE + 1), DEADLINE)!;
		expect(result.status).toBe('late');
		expect(result.fields.latencyMs).toBe(DEADLINE + 1);
		expect(result.fields.deadlineMs).toBe(DEADLINE);
	});

	test('exactly at the deadline is still `cached`', () => {
		expect(buildCompletionResult(completedHash(1_000_000, 1_000_000 + DEADLINE), DEADLINE)!.status).toBe('cached');
	});

	test('a hash without `accepted` (written before this existed) is `cached` with no latency', () => {
		const flat = completedHash(1, 2).filter((_, i, a) => a[i - 1] !== 'accepted' && a[i] !== 'accepted');
		const result = buildCompletionResult(flat, DEADLINE)!;
		expect(result.status).toBe('cached');
		expect(result.fields.latencyMs).toBeUndefined();
		expect(result.fields.acceptedAt).toBeUndefined();
	});

	test('a record with neither a WNM nor a data_id is not a notification: no line', () => {
		expect(buildCompletionResult(['type', 'something'], DEADLINE)).toBeNull();
	});

	test('a WNM that does not parse still yields a line from the record fields', () => {
		const flat = completedHash(1000, 2000);
		flat[flat.indexOf('wnm') + 1] = '{not json';
		const result = buildCompletionResult(flat, DEADLINE)!;
		expect(result.status).toBe('cached');
		expect(result.fields.data_id).toBe('data-1');
		expect(result.fields.wnm).toBeUndefined();
	});
});

describe('buildFailedResult', () => {
	test('carries the exhausted download: ids, reason, attempt, failure time and the WNM', () => {
		const result = buildFailedResult([
			'type', 'download_failed',
			'downloader_id', 'wis2:centre:abc',
			'reason', 'integrity',
			'failed_at', String(Date.parse('2026-10-24T08:01:12.300Z')),
			'data_id', 'data-1',
			'topic', 'origin/a/wis2/fr-meteofrance/data/core/weather/surface-based-observations/synop',
			'published', '2026-10-24T07:50:02Z',
			'accepted', String(Date.parse('2026-10-24T07:55:10.020Z')),
			'attempt', '3',
			'wnm', JSON.stringify(WNM),
		]);
		expect(result.status).toBe('failed');
		expect(result.fields).toMatchObject({
			data_id: 'data-1',
			downloader_id: 'wis2:centre:abc',
			wnm_id: 'wnm-1',
			reason: 'integrity',
			attempt: '3',
			failedAt: '2026-10-24T08:01:12.300Z',
			acceptedAt: '2026-10-24T07:55:10.020Z',
		});
		expect((result.fields.wnm as { downloader_id?: string }).downloader_id).toBeUndefined();
	});

	test('when the hash was already gone only the ids and the reason remain', () => {
		const result = buildFailedResult(['type', 'download_failed', 'downloader_id', 'wis2:centre:gone', 'reason', 'download_error', 'failed_at', '1000']);
		expect(result.status).toBe('failed');
		expect(result.fields.downloader_id).toBe('wis2:centre:gone');
		expect(result.fields.reason).toBe('download_error');
		expect(result.fields.wnm).toBeUndefined();
		expect(result.fields.data_id).toBeUndefined();
	});
});

describe('buildMissedResult', () => {
	const pending = [
		HREF, 'queue',
		`src:${HREF}`, 'origin',
		'wnm', JSON.stringify(WNM),
		'topic', 'origin/a/wis2/fr-meteofrance/data/core/weather/surface-based-observations/synop',
		'published', '2026-10-24T07:50:02Z',
		'attempt', '2',
		'data_id', 'data-1',
		'accepted', String(Date.parse('2026-10-24T07:55:10.020Z')),
	];

	test('is built from the downloader_id hash: ids, href, attempt, deadline, acceptedAt and the WNM; no cachedAt or latency', () => {
		const result = buildMissedResult('wis2:centre:abc', pending, DEADLINE);
		expect(result.status).toBe('missed');
		expect(result.fields).toMatchObject({
			data_id: 'data-1',
			downloader_id: 'wis2:centre:abc',
			wnm_id: 'wnm-1',
			href: HREF,
			attempt: '2',
			deadlineMs: DEADLINE,
			acceptedAt: '2026-10-24T07:55:10.020Z',
		});
		expect(result.fields.cachedAt).toBeUndefined();
		expect(result.fields.latencyMs).toBeUndefined();
	});

	test('with the hash gone it still names the downloader_id and the deadline', () => {
		const result = buildMissedResult('wis2:centre:gone', [], DEADLINE);
		expect(result.status).toBe('missed');
		expect(result.fields.downloader_id).toBe('wis2:centre:gone');
		expect(result.fields.deadlineMs).toBe(DEADLINE);
		expect(result.fields.data_id).toBeUndefined();
	});
});

describe('isCompleted', () => {
	test('is true once any href is complete, false while queued, waiting or errored, and for an empty record', () => {
		expect(isCompleted(completedHash(1, 2))).toBe(true);
		expect(isCompleted([HREF, 'queue', 'attempt', '1'])).toBe(false);
		expect(isCompleted([HREF, 'wait'])).toBe(false);
		expect(isCompleted([HREF, 'error'])).toBe(false);
		expect(isCompleted([])).toBe(false);
	});
});
