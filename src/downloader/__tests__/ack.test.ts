import { describe, expect, test } from 'bun:test';
import { startAck } from '../ack.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

class ThrowingDeleteStore extends FakeDownloaderStore {
	override async deleteAria2GidRecord(): Promise<void> {
		throw new Error('redis: connection reset');
	}
}

describe('startAck', () => {
	test('returns null when there is no aria2_gid record at all', async () => {
		const store = new FakeDownloaderStore();
		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'missing-gid');
		expect(result).toBeNull();
	});

	test('returns null when the stream_id fails the "First ?" regex (not <millis>-<seq>[-<n>])', async () => {
		const store = new FakeDownloaderStore();
		store.aria2GidRecords.set('downloader1:some-gid', ['stream_id', 'not-a-stream-id', 'downloader_id', 'x']);
		const result = await startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'some-gid');
		expect(result).toBeNull();
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

	test('"Ack" (Debug): a failure in the cleanup fan-out logs once and still rethrows', async () => {
		const store = new ThrowingDeleteStore();
		store.aria2GidRecords.set('downloader1:gid-err', ['stream_id', '1694198400000-0-999999', 'downloader_id', 'x', 'download_entry_id', '1694198400000-0']);
		const { logger, debugCalls } = fakeSourceLogger();

		await expect(startAck(store, 'wis2gc:downloader-queue', 'downloader1', 'gid-err', logger)).rejects.toThrow('redis: connection reset');

		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toMatchObject({ worker: 'downloader1', gid: 'gid-err', streamId: '1694198400000-0-999999', error: 'redis: connection reset' });
	});
});
