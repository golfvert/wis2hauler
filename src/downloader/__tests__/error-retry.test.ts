import { describe, expect, test } from 'bun:test';
import { reportBadHash, reportDownloadError, runRetryDecision, type ErrorRetryDeps } from '../error-retry.ts';
import type { AriaStartDeps } from '../aria-start.ts';
import type { Aria2Client } from '../aria2.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; warnCalls: Record<string, unknown>[] } {
	const warnCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: (d) => warnCalls.push(d), debug: () => {} }, warnCalls };
}

function makeFakeAria2(gid = 'requeue-gid'): Aria2Client {
	return { addUri: async () => gid } as unknown as Aria2Client;
}

function makeDeps(store: FakeDownloaderStore, sleeps: number[] = []): ErrorRetryDeps {
	const ariaStart: AriaStartDeps = {
		store,
		worker: 'downloader1',
		aria2: makeFakeAria2(),
		credentials: () => undefined,
		checkCertificate: undefined,
		randomStreamSuffix: () => '000000',
	};
	return {
		store,
		queue: 'wis2gc:downloader-queue',
		worker: 'downloader1',
		ariaStart,
		sleep: async (ms: number) => {
			sleeps.push(ms);
		},
		mintRequeueId: () => 'requeue-1',
	};
}

describe('reportBadHash / reportDownloadError', () => {
	test('reportBadHash publishes an integrity_fail cleaner-reporter notification', async () => {
		const store = new FakeDownloaderStore();
		await reportBadHash(makeDeps(store), 'origin/a/wis2/centre/foo');
		expect(store.cleanerReports).toEqual([{ worker: 'downloader1', report: JSON.stringify(['type', 'integrity_fail', 'topic', 'origin/a/wis2/centre/foo']) }]);
	});

	test('reportDownloadError publishes a download_error notification with the given topic', async () => {
		const store = new FakeDownloaderStore();
		await reportDownloadError(makeDeps(store), 'origin/a/wis2/centre/foo');
		expect(store.cleanerReports).toEqual([{ worker: 'downloader1', report: JSON.stringify(['type', 'download_error', 'topic', 'origin/a/wis2/centre/foo']) }]);
	});

	test('reportDownloadError falls back to an empty topic string when wnmtopic is unknown', async () => {
		const store = new FakeDownloaderStore();
		await reportDownloadError(makeDeps(store), undefined);
		expect(store.cleanerReports).toEqual([{ worker: 'downloader1', report: JSON.stringify(['type', 'download_error', 'topic', '']) }]);
	});
});

describe('runRetryDecision', () => {
	test('RETRY_OK: promotes the first waiting href, starts a real aria2 download for it, and applies the LUA_RETRY transition', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/a.grib2': 'wait', topic: 'origin/a/wis2/centre/foo' });
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(sleeps).toEqual([30000, 5000]);

		const promoted = store.aria2GidRecords.get('downloader1:requeue-gid');
		expect(promoted).toBeDefined();
		expect(promoted?.[promoted.indexOf('href') + 1]).toBe('https://example.com/a.grib2');
		// download_entry_id is "" for a retry, not the synthetic
		// mintRequeueId() value: that id was never itself a real
		// work-queue entry (the original one was already XACK'd/XDEL'd
		// back when this download first failed), so aria-start.ts leaves
		// workQueueEntryId unset here -- see ack.ts's startAck() for the
		// "ERR Invalid stream ID..." bug this avoids.
		expect(promoted?.[promoted.indexOf('download_entry_id') + 1]).toBe('');

		const hash = store.hashes.get('wis2:centre:abc')!;
		expect(hash['https://example.com/a.grib2']).toBe('queue');
		expect(hash.attempt).toBe('1');

		expect(store.errors).toHaveLength(0);
	});

	test('"Re-queue" and "Update" (both Warn): RETRY_OK logs once on each, with the promoted href/topic and the new attempt', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/a.grib2': 'wait', topic: 'origin/a/wis2/centre/foo' });
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);
		const { logger: requeueLog, warnCalls: requeueCalls } = fakeSourceLogger();
		const { logger: updateLog, warnCalls: updateCalls } = fakeSourceLogger();
		deps.requeueLog = requeueLog;
		deps.updateLog = updateLog;

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(requeueCalls).toHaveLength(1);
		expect(requeueCalls[0]).toMatchObject({ downloader_id: 'wis2:centre:abc', href: 'https://example.com/a.grib2', topic: 'origin/a/wis2/centre/foo' });
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]).toMatchObject({ downloader_id: 'wis2:centre:abc' });
	});

	test('RETRY_NOK does not log "Re-queue"/"Update" -- those are RETRY_OK-only', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/b.grib2': 'queue' });
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);
		const { logger: requeueLog, warnCalls: requeueCalls } = fakeSourceLogger();
		deps.requeueLog = requeueLog;

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(requeueCalls).toHaveLength(0);
	});

	test('RETRY_NOK logs "Retry Failed" (warn) before recording the exhausted job; RETRY_OK does not', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/b.grib2': 'queue', data_id: 'data-abc' });
		const deps = makeDeps(store);
		const { logger: retryFailedLog, warnCalls } = fakeSourceLogger();
		deps.retryFailedLog = retryFailedLog;

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(warnCalls).toEqual([{ downloader_id: 'wis2:centre:abc', data_id: 'data-abc', hashFound: true }]);
		expect(store.errors).toHaveLength(1);

		const goneStore = new FakeDownloaderStore();
		const goneDeps = makeDeps(goneStore);
		const { logger: goneLog, warnCalls: goneCalls } = fakeSourceLogger();
		goneDeps.retryFailedLog = goneLog;
		await runRetryDecision(goneDeps, 'wis2:centre:gone');
		expect(goneCalls).toEqual([{ downloader_id: 'wis2:centre:gone', data_id: '', hashFound: false }]);
	});

	test('RETRY_NOK: records the exhausted job on the error stream, no download is retried', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/b.grib2': 'queue' });
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(sleeps).toEqual([30000]);
		expect(store.errors).toHaveLength(1);
		expect(store.errors[0]!.queue).toBe('wis2gc:downloader-queue');
		expect(store.errors[0]!.worker).toBe('downloader1');
		// Wrapped with downloader_id/hashFound since 2026-09-13 (NOT a
		// port -- see error-retry.ts's own comment) so an exhausted
		// retry's log entry is actually correlatable to which download
		// it was for.
		const recorded = JSON.parse(store.errors[0]!.payload) as { downloader_id: string; hashFound: boolean; hash: string[] };
		expect(recorded.downloader_id).toBe('wis2:centre:abc');
		expect(recorded.hashFound).toBe(true);
		expect(recorded.hash).toContain('error');
		expect(store.aria2GidRecords.size).toBe(0);
	});

	test('RETRY_NOK: sends one download_failed report (ids, reason, attempt, accepted, wnm) and deletes the deadline marker', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', {
			'https://example.com/b.grib2': 'queue',
			wnm: '{"id":"w1","properties":{"data_id":"d1"}}',
			topic: 'origin/a/wis2/centre/foo',
			published: '2026-10-24T07:50:02Z',
			accepted: '1000',
			attempt: '3',
			data_id: 'd1',
			'local-path': 'must-not-be-copied',
		});
		store.cacheMarkers.add('wis2:centre:abc');
		const deps = makeDeps(store, []);

		await runRetryDecision(deps, 'wis2:centre:abc', 'integrity');

		expect(store.deletedMarkers).toEqual(['wis2:centre:abc']);
		expect(store.cleanerReports).toHaveLength(1);
		const report = JSON.parse(store.cleanerReports[0]!.report) as string[];
		const rec = Object.fromEntries(Array.from({ length: report.length / 2 }, (_, i) => [report[i * 2]!, report[i * 2 + 1]!]));
		expect(rec.type).toBe('download_failed');
		expect(rec.downloader_id).toBe('wis2:centre:abc');
		expect(rec.reason).toBe('integrity');
		expect(Number(rec.failed_at)).toBeGreaterThan(0);
		expect(rec.data_id).toBe('d1');
		expect(rec.accepted).toBe('1000');
		expect(rec.attempt).toBe('3');
		expect(rec.wnm).toBe('{"id":"w1","properties":{"data_id":"d1"}}');
		// The CLEANER listens on the same channel and schedules a deletion for any report with a local-path.
		expect(report).not.toContain('local-path');
	});

	test('RETRY_NOK with the hash already gone still reports the failure, by downloader_id', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store, []);

		await runRetryDecision(deps, 'wis2:centre:gone', 'download_error');

		const report = JSON.parse(store.cleanerReports[0]!.report) as string[];
		expect(report.slice(0, 6)).toEqual(['type', 'download_failed', 'downloader_id', 'wis2:centre:gone', 'reason', 'download_error']);
		expect(report).not.toContain('wnm');
		expect(store.deletedMarkers).toEqual(['wis2:centre:gone']);
	});

	test('RETRY_OK sends no failure report and leaves the marker: the download is still being tried', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/a.grib2': 'wait', topic: 'origin/a/wis2/centre/foo' });
		store.cacheMarkers.add('wis2:centre:abc');
		const deps = makeDeps(store, []);

		await runRetryDecision(deps, 'wis2:centre:abc', 'integrity');

		expect(store.cleanerReports).toHaveLength(0);
		expect(store.deletedMarkers).toEqual([]);
	});

	test('RETRY_NOK: hashFound is false when the downloader_id hash was already gone by the 30s check', async () => {
		const store = new FakeDownloaderStore();
		// No store.hashes.set(...) at all -- getDownloaderRecord returns [] for a key that was never written or has since vanished.
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);

		await runRetryDecision(deps, 'wis2:centre:gone');

		expect(store.errors).toHaveLength(1);
		const recorded = JSON.parse(store.errors[0]!.payload) as { downloader_id: string; hashFound: boolean; hash: string[] };
		expect(recorded.downloader_id).toBe('wis2:centre:gone');
		expect(recorded.hashFound).toBe(false);
		expect(recorded.hash).toEqual([]);
	});

	test('RETRY_NONEED: an already-complete message is a silent no-op', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/c.grib2': 'complete' });
		const sleeps: number[] = [];
		const deps = makeDeps(store, sleeps);

		await runRetryDecision(deps, 'wis2:centre:abc');

		expect(sleeps).toEqual([30000]);
		expect(store.errors).toHaveLength(0);
		expect(store.aria2GidRecords.size).toBe(0);
	});
});
