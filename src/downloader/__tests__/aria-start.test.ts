import { describe, expect, test } from 'bun:test';
import { startRealDownload, type AriaStartDeps, type AriaStartEntry } from '../aria-start.ts';
import type { Aria2Client } from '../aria2.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

function makeFakeAria2(gid: string): { aria2: Aria2Client; calls: { href: string; options: unknown }[] } {
	const calls: { href: string; options: unknown }[] = [];
	const fake = {
		addUri: async (href: string, options: unknown) => {
			calls.push({ href, options });
			return gid;
		},
	};
	return { aria2: fake as unknown as Aria2Client, calls };
}

const entry: AriaStartEntry = {
	id: '1694198400000-0',
	downloaderId: 'wis2:centre:abc',
	href: 'https://example.com/foo/bar.grib2',
	topic: 'origin/a/wis2/centre/foo',
	workQueueEntryId: '1694198400000-0',
};

describe('startRealDownload', () => {
	test('registers a stream-id pre-registration record, calls aria2.addUri, then promotes it to the gid-keyed hash', async () => {
		const store = new FakeDownloaderStore();
		const { aria2, calls } = makeFakeAria2('aria2-gid-1');
		const deps: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => undefined,
			checkCertificate: undefined,
			randomStreamSuffix: () => '999999',
		};

		await startRealDownload(deps, entry);

		// Filename is built from the (already-unique) streamId, not
		// downloaderId's content-derived tail -- see startRealDownload's
		// collision-avoidance comment.
		expect(store.streamEntries.get('downloader1:1694198400000-0-999999')).toEqual({
			streamId: '1694198400000-0-999999',
			downloaderId: 'wis2:centre:abc',
			downloadEntryId: '1694198400000-0',
			href: 'https://example.com/foo/bar.grib2',
			filename: '1694198400000-0-999999_bar.grib2',
		});
		expect(store.streamExpires.has('downloader1:1694198400000-0-999999')).toBe(true);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.href).toBe('https://example.com/foo/bar.grib2');
		expect(calls[0]!.options).toEqual({ filename: '1694198400000-0-999999_bar.grib2', checkCertificate: undefined, credentials: undefined });

		const promoted = store.aria2GidRecords.get('downloader1:aria2-gid-1');
		expect(promoted).toEqual([
			'stream_id',
			'1694198400000-0-999999',
			'downloader_id',
			'wis2:centre:abc',
			'download_entry_id',
			'1694198400000-0',
			'href',
			'https://example.com/foo/bar.grib2',
			'filename',
			'1694198400000-0-999999_bar.grib2',
		]);
		expect(store.cancelSchedule.has('downloader1|aria2-gid-1')).toBe(true);
	});

	test('"Aria" (Debug): logs once with the href, filename, and the gid aria2 answered with', async () => {
		const store = new FakeDownloaderStore();
		const { aria2 } = makeFakeAria2('aria2-gid-debug');
		const { logger, debugCalls } = fakeSourceLogger();
		const deps: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => undefined,
			checkCertificate: undefined,
			randomStreamSuffix: () => '999999',
			ariaLog: logger,
		};

		await startRealDownload(deps, entry);

		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toMatchObject({ href: entry.href, filename: '1694198400000-0-999999_bar.grib2', gid: 'aria2-gid-debug', hasCredentials: false });
	});

	test('looks up credentials by topic and forwards checkCertificate', async () => {
		const store = new FakeDownloaderStore();
		const { aria2, calls } = makeFakeAria2('aria2-gid-2');
		const creds = { 'origin/a/wis2/centre/foo': { username: 'alice', password: 'secret' } };
		const deps: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => creds,
			checkCertificate: false,
			randomStreamSuffix: () => '111111',
		};

		await startRealDownload(deps, entry);

		expect(calls[0]!.options).toEqual({ filename: '1694198400000-0-111111_bar.grib2', checkCertificate: false, credentials: { username: 'alice', password: 'secret' } });
	});

	test('a topic with no matching credentials entry passes credentials: undefined', async () => {
		const store = new FakeDownloaderStore();
		const { aria2, calls } = makeFakeAria2('aria2-gid-3');
		const deps: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => ({ 'some/other/topic': { username: 'x', password: 'y' } }),
			checkCertificate: undefined,
			randomStreamSuffix: () => '222222',
		};

		await startRealDownload(deps, entry);

		expect((calls[0]!.options as { credentials?: unknown }).credentials).toBeUndefined();
	});

	// Found 2026-09-13: error-retry.ts's runRetryDecision() never sets
	// workQueueEntryId (mintRequeueId()'s synthetic id was never itself
	// a real work-queue entry, and the original one was already
	// XACK'd/XDEL'd back on the attempt that failed) -- registered here
	// as download_entry_id === "", which ack.ts's startAck() then reads
	// as "skip the XACK/XDEL, there's nothing real to ack".
	test('a retried href (workQueueEntryId omitted) registers download_entry_id as "" rather than the synthetic streamId half', async () => {
		const store = new FakeDownloaderStore();
		const { aria2 } = makeFakeAria2('aria2-gid-retry');
		const retryEntry: AriaStartEntry = {
			id: '1757740000123-99-482910',
			downloaderId: 'wis2:centre:abc',
			href: 'https://example.com/foo/bar.grib2',
			topic: 'origin/a/wis2/centre/foo',
		};
		const deps: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => undefined,
			checkCertificate: undefined,
			randomStreamSuffix: () => '654321',
		};

		await startRealDownload(deps, retryEntry);

		expect(store.streamEntries.get('downloader1:1757740000123-99-482910-654321')?.downloadEntryId).toBe('');
	});

	// 2026-09-19 (the maintainer: "avoid collision in aria2, in rename and
	// in content"): two WNMs with no integrity block and the same href
	// basename used to compute the identical aria2 `out` filename
	// (downloaderId's content-derived tail falls back to just the pubtime
	// digits, and only the href's basename -- not its full path -- was
	// used). The deployed aria2 image defaults to allow-overwrite=true,
	// auto-file-renaming=false (per its entrypoint.sh), so that used to
	// mean a silent on-disk overwrite, not a rename or a rejection.
	// Confirms two such entries now get different `out` filenames.
	test('two entries with the same href basename never collide on the aria2 out filename', async () => {
		const storeA = new FakeDownloaderStore();
		const storeB = new FakeDownloaderStore();
		const { aria2: aria2A, calls: callsA } = makeFakeAria2('aria2-gid-a');
		const { aria2: aria2B, calls: callsB } = makeFakeAria2('aria2-gid-b');
		const entryA: AriaStartEntry = {
			id: '1694198400000-0',
			downloaderId: 'wis2:centre-a:1694198400',
			href: 'https://a.example.com/dir1/data.grib2',
			topic: 'origin/a/wis2/centre-a/foo',
			workQueueEntryId: '1694198400000-0',
		};
		const entryB: AriaStartEntry = {
			id: '1694198400000-1',
			downloaderId: 'wis2:centre-b:1694198400',
			href: 'https://b.example.com/dir2/data.grib2',
			topic: 'origin/a/wis2/centre-b/foo',
			workQueueEntryId: '1694198400000-1',
		};

		await startRealDownload({ store: storeA, worker: 'downloader1', aria2: aria2A, credentials: () => undefined, checkCertificate: undefined, randomStreamSuffix: () => '111111' }, entryA);
		await startRealDownload({ store: storeB, worker: 'downloader1', aria2: aria2B, credentials: () => undefined, checkCertificate: undefined, randomStreamSuffix: () => '222222' }, entryB);

		const filenameA = (callsA[0]!.options as { filename: string }).filename;
		const filenameB = (callsB[0]!.options as { filename: string }).filename;
		expect(filenameA).not.toBe(filenameB);
	});
});
