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
		expect(promoted?.[promoted.indexOf('download_entry_id') + 1]).toBe('requeue-1');

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
		expect(requeueCalls[0]).toMatchObject({ downloaderId: 'wis2:centre:abc', href: 'https://example.com/a.grib2', topic: 'origin/a/wis2/centre/foo' });
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0]).toMatchObject({ downloaderId: 'wis2:centre:abc' });
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
		const payload = JSON.parse(store.errors[0]!.payload) as string[];
		expect(payload).toContain('error');
		expect(store.aria2GidRecords.size).toBe(0);
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
