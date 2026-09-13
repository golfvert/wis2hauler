import { describe, expect, test } from 'bun:test';
import { startAck } from '../ack.ts';
import { startRealDownload, type AriaStartDeps, type AriaStartEntry } from '../aria-start.ts';
import type { Aria2Client } from '../aria2.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

// Mimics real Redis's own XACK/XDEL id validation (confirmed against a
// live redis-server 7.0.15, 2026-09-13: XACK/XDEL reject anything not
// shaped "<ms>-<seq>" with the exact error text below) -- unlike
// FakeDownloaderStore, which never throws, so it alone can't reproduce
// the production bug this file guards against.
const VALID_STREAM_ID = /^\d+-\d+$/;
class RedisLikeAckStore extends FakeDownloaderStore {
	override async ackWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		if (!VALID_STREAM_ID.test(entryId)) throw new Error('ERR Invalid stream ID specified as stream command argument');
		await super.ackWorkQueueEntry(queue, entryId);
	}
	override async deleteWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		if (!VALID_STREAM_ID.test(entryId)) throw new Error('ERR Invalid stream ID specified as stream command argument');
		await super.deleteWorkQueueEntry(queue, entryId);
	}
}

function fakeSourceLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

function fakeWarnLogger(): { logger: SourceLogger; warnCalls: Record<string, unknown>[] } {
	const warnCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: (d) => warnCalls.push(d), debug: () => {} }, warnCalls };
}

// Instant, not real timers -- every test below that exercises the
// no-record-found path passes this instead of ack.ts's real
// defaultSleep, so the retry loop still runs (proving the retry
// behavior itself) without actually waiting 400ms per test.
const instantSleep = async (_ms: number): Promise<void> => {};

class ThrowingDeleteStore extends FakeDownloaderStore {
	override async deleteAria2GidRecord(): Promise<void> {
		throw new Error('redis: connection reset');
	}
}

describe('startAck', () => {
	test('returns null when there is no aria2_gid record at all, after retrying', async () => {
		const store = new FakeDownloaderStore();
		const delays: number[] = [];
		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'missing-gid', undefined, async (ms) => void delays.push(ms));
		expect(result).toBeNull();
		expect(delays).toEqual([100, 300]); // both retries exhausted, real record never appeared
	});

	test('returns null when the stream_id fails the "First ?" regex (not <millis>-<seq>[-<n>])', async () => {
		const store = new FakeDownloaderStore();
		store.aria2GidRecords.set('downloader1:some-gid', ['stream_id', 'not-a-stream-id', 'downloader_id', 'x']);
		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'some-gid', undefined, instantSleep);
		expect(result).toBeNull();
	});

	// NOT a port -- see ack.ts's own RETRY_DELAYS_MS comment: a download
	// fast enough that its onDownloadComplete notification arrives before
	// aria-start.ts's gid-promotion (getStreamEntry -> setAria2GidFields)
	// has finished writing the aria2_gid record must not be treated the
	// same as a genuinely-already-cleaned-up one.
	describe('retry (gid-promotion race)', () => {
		test('a record that only appears after the first retry is picked up, not lost to the race', async () => {
			const store = new FakeDownloaderStore();
			let sleepCalls = 0;
			const sleep = async (): Promise<void> => {
				sleepCalls++;
				if (sleepCalls === 1) {
					// Simulates aria-start.ts's promotion finishing during the
					// wait, exactly the race this retry exists to survive.
					store.aria2GidRecords.set('downloader1:late-gid', ['stream_id', '1694198400000-0-999999', 'downloader_id', 'wis2:centre:abc']);
				}
			};

			const result = await startAck(store, 'q', 'downloader1', 'late-gid', undefined, sleep);

			expect(result?.streamId).toBe('1694198400000-0-999999');
			expect(sleepCalls).toBe(1); // only needed the FIRST retry, not both
		});

		test('a record that only appears after the second retry is still picked up', async () => {
			const store = new FakeDownloaderStore();
			let sleepCalls = 0;
			const sleep = async (): Promise<void> => {
				sleepCalls++;
				if (sleepCalls === 2) {
					store.aria2GidRecords.set('downloader1:very-late-gid', ['stream_id', '1694198400000-0-999999', 'downloader_id', 'wis2:centre:abc']);
				}
			};

			const result = await startAck(store, 'q', 'downloader1', 'very-late-gid', undefined, sleep);

			expect(result?.streamId).toBe('1694198400000-0-999999');
			expect(sleepCalls).toBe(2);
		});

		test('gives up and logs a warn (with the retry count) when the record never appears', async () => {
			const store = new FakeDownloaderStore();
			const { logger, warnCalls } = fakeWarnLogger();

			const result = await startAck(store, 'q', 'downloader1', 'ghost-gid', logger, instantSleep);

			expect(result).toBeNull();
			expect(warnCalls).toEqual([{ worker: 'downloader1', gid: 'ghost-gid', retries: 2, reason: 'no aria2_gid record found after retrying (First ? check)' }]);
		});

		test('a genuinely-already-cleaned-up record (real double-ack race) still returns null, not a false recovery', async () => {
			const store = new FakeDownloaderStore();
			// Never set -- this is the ordinary case the regex/existence
			// check was originally built for, unaffected by the retry.
			const result = await startAck(store, 'q', 'downloader1', 'truly-gone-gid', undefined, instantSleep);
			expect(result).toBeNull();
		});
	});

	test('a real-shaped stream_id acks the queue entry and cleans up all 3 keys', async () => {
		const store = new FakeDownloaderStore();
		store.aria2GidRecords.set('downloader1:gid-1', [
			'stream_id',
			'1694198400000-0-999999',
			'downloader_id',
			'wis2:centre:abc',
			'download_entry_id',
			'1694198400000-0',
			'href',
			'https://example.com/f.grib2',
			'filename',
			'abc_f.grib2',
		]);

		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'gid-1');

		expect(result).toEqual({
			streamId: '1694198400000-0-999999',
			downloaderId: 'wis2:centre:abc',
			downloadEntryId: '1694198400000-0',
			href: 'https://example.com/f.grib2',
			filename: 'abc_f.grib2',
		});
		expect(store.acked).toEqual([{ queue: 'wis2gc:downloader-queue', entryId: '1694198400000-0' }]);
		expect(store.xdeleted).toEqual([{ queue: 'wis2gc:downloader-queue', entryId: '1694198400000-0' }]);
		expect(store.deletedStreamEntries).toEqual(['downloader1:1694198400000-0-999999']);
		expect(store.deletedStreamEntryExpires).toEqual(['downloader1:1694198400000-0-999999']);
		expect(store.deletedAria2GidRecords).toEqual(['downloader1:gid-1']);
	});

	test('a synthetic (decode-write) gid shaped like <millis>-<seq>-<random> also passes the regex', async () => {
		const store = new FakeDownloaderStore();
		store.aria2GidRecords.set('downloader1:1694198400000-0-654321', ['stream_id', '1694198400000-0-654321', 'downloader_id', 'x', 'download_entry_id', '1694198400000-0']);

		const result = await startAck(store, 'q', 'downloader1', '1694198400000-0-654321');

		expect(result?.streamId).toBe('1694198400000-0-654321');
	});

	// REWRITTEN 2026-09-13 (found live in production): the cleanup
	// fan-out below (XACK/XDEL + 3 DELs) must never abort startAck()
	// itself -- the original wires each of these 5 Redis commands to
	// its OWN Catch node (Debug-only, never halting the flow onward to
	// Complete/WNM-publish); a literal Promise.all here instead let one
	// failing call (see the empty-download_entry_id test below) throw
	// straight out of startAck(), silently dropping every retried
	// download's whole completion. Still logs via ackLog, just never
	// rethrows.
	test('"Ack" (Debug): a failure in the cleanup fan-out logs once but does not stop startAck() from returning the AckedEntry', async () => {
		const store = new ThrowingDeleteStore();
		store.aria2GidRecords.set('downloader1:gid-err', ['stream_id', '1694198400000-0-999999', 'downloader_id', 'x', 'download_entry_id', '1694198400000-0']);
		const { logger, debugCalls } = fakeSourceLogger();

		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'gid-err', logger);

		expect(result?.streamId).toBe('1694198400000-0-999999');
		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toMatchObject({ worker: 'downloader1', gid: 'gid-err', streamId: '1694198400000-0-999999', error: 'redis: connection reset' });
	});

	// Found 2026-09-13: a RETRIED download (error-retry.ts's
	// runRetryDecision -> aria-start.ts's startRealDownload, which
	// leaves workQueueEntryId unset) has NO real work-queue entry left
	// to ack -- the original entry was already XACK'd/XDEL'd back when
	// this download first failed. Its aria2_gid record's
	// download_entry_id is therefore '', and ackWorkQueueEntry/
	// deleteWorkQueueEntry must be skipped entirely rather than issuing
	// a guaranteed-to-fail XACK/XDEL against a synthetic, never-enqueued
	// id (real Redis rejects a malformed id with "ERR Invalid stream ID
	// specified as stream command argument").
	test('a retried download (download_entry_id === "") skips ackWorkQueueEntry/deleteWorkQueueEntry entirely, but still cleans up the other 3 keys', async () => {
		const store = new FakeDownloaderStore();
		store.aria2GidRecords.set('downloader1:requeue-gid', [
			'stream_id',
			'1757740000123-99-482910-654321',
			'downloader_id',
			'wis2:centre:abc',
			'download_entry_id',
			'',
			'href',
			'https://example.com/f.grib2',
			'filename',
			'abc_f.grib2',
		]);

		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'requeue-gid');

		expect(result?.downloadEntryId).toBe('');
		expect(store.acked).toEqual([]);
		expect(store.xdeleted).toEqual([]);
		expect(store.deletedStreamEntries).toEqual(['downloader1:1757740000123-99-482910-654321']);
		expect(store.deletedStreamEntryExpires).toEqual(['downloader1:1757740000123-99-482910-654321']);
		expect(store.deletedAria2GidRecords).toEqual(['downloader1:requeue-gid']);
	});

	// End-to-end regression test for the exact production report ("I see
	// this in the logs: DOWNLOADER: post-download processing failed: ERR
	// Invalid stream ID specified as stream command argument"): runs a
	// RETRIED download through the real aria-start.ts -> ack.ts pipeline
	// (not a hand-built fixture record) against a store that enforces
	// Redis's own id-shape validation, proving the fix holds across both
	// files together, not just each in isolation.
	test('a full retry-then-complete cycle never throws, even against a store that enforces real Redis id validation', async () => {
		const store = new RedisLikeAckStore();
		const aria2: Aria2Client = { addUri: async () => 'aria2-gid-retry-e2e' } as unknown as Aria2Client;
		const ariaStart: AriaStartDeps = {
			store,
			worker: 'downloader1',
			aria2,
			credentials: () => undefined,
			checkCertificate: undefined,
			randomStreamSuffix: () => '482910',
		};
		// error-retry.ts's runRetryDecision builds exactly this shape:
		// mintRequeueId()'s synthetic id, no workQueueEntryId.
		const retryEntry: AriaStartEntry = {
			id: '1757740000123-99-654321',
			downloaderId: 'wis2:centre:abc',
			href: 'https://example.com/f.grib2',
			topic: 'origin/a/wis2/centre/foo',
		};

		await startRealDownload(ariaStart, retryEntry);
		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'aria2-gid-retry-e2e');

		expect(result).not.toBeNull();
		expect(result?.downloadEntryId).toBe('');
		expect(store.acked).toEqual([]);
		expect(store.xdeleted).toEqual([]);
	});
});
