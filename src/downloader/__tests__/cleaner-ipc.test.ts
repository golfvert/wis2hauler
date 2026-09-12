import { describe, expect, test } from 'bun:test';
import { pollCleanerCommands, processCleanerCommands, runCleanerIpcLoop, type CleanerIpcDeps } from '../cleaner-ipc.ts';
import type { AriaStartDeps } from '../aria-start.ts';
import type { ErrorRetryDeps } from '../error-retry.ts';
import type { Aria2Client } from '../aria2.ts';
import type { WorkerCommandEntry } from '../store.ts';
import { FakeDownloaderStore } from './fakes.ts';

function makeDeps(store: FakeDownloaderStore, overrides: Partial<CleanerIpcDeps> = {}): { deps: CleanerIpcDeps; unlinked: string[]; warnings: string[] } {
	const unlinked: string[] = [];
	const warnings: string[] = [];
	const ariaStart: AriaStartDeps = {
		store,
		worker: 'downloader1',
		aria2: { addUri: async () => 'gid' } as unknown as Aria2Client,
		credentials: () => undefined,
		checkCertificate: undefined,
		randomStreamSuffix: () => '000000',
	};
	const errorRetry: ErrorRetryDeps = {
		store,
		queue: 'wis2gc:downloader-queue',
		worker: 'downloader1',
		ariaStart,
		sleep: async () => {},
		mintRequeueId: () => 'requeue-1',
	};
	const deps: CleanerIpcDeps = {
		store,
		queue: 'wis2gc:downloader-queue',
		worker: 'downloader1',
		errorRetry,
		ariaDownloadDir: '/downloads',
		unlinkAsync: async (filepath: string) => {
			unlinked.push(filepath);
		},
		warn: (m: string) => warnings.push(m),
		sleep: async () => {},
		...overrides,
	};
	return { deps, unlinked, warnings };
}

describe('processCleanerCommands', () => {
	test('a delete action unlinks /downloads/<filename>', async () => {
		const store = new FakeDownloaderStore();
		const { deps, unlinked } = makeDeps(store);
		const entries: WorkerCommandEntry[] = [{ id: '1-0', fields: ['action', 'delete', 'filename', 'foo.grib2'] }];

		await Promise.all(processCleanerCommands(deps, entries));

		expect(unlinked).toEqual(['/downloads/foo.grib2']);
	});

	test('a failed delete is warned about, not thrown', async () => {
		const store = new FakeDownloaderStore();
		const { deps, warnings } = makeDeps(store, {
			unlinkAsync: async () => {
				throw new Error('ENOENT');
			},
		});
		const entries: WorkerCommandEntry[] = [{ id: '1-0', fields: ['action', 'delete', 'filename', 'foo.grib2'] }];

		await Promise.all(processCleanerCommands(deps, entries));

		expect(warnings).toHaveLength(1);
	});

	test('a cancel action acks the download and routes it into the error/retry pipeline', async () => {
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
		const { deps } = makeDeps(store);
		const entries: WorkerCommandEntry[] = [{ id: '1-0', fields: ['action', 'cancel', 'aria2_gid', 'gid-1'] }];

		await Promise.all(processCleanerCommands(deps, entries));

		expect(store.acked).toEqual([{ queue: 'wis2gc:downloader-queue', entryId: '1694198400000-0' }]);
		expect(store.cleanerReports).toEqual([{ worker: 'downloader1', report: JSON.stringify(['type', 'download_error', 'topic', '']) }]);
	});

	test('a cancel action for an already-gone gid is a silent no-op (startAck rejects it)', async () => {
		const store = new FakeDownloaderStore();
		const { deps } = makeDeps(store);
		const entries: WorkerCommandEntry[] = [{ id: '1-0', fields: ['action', 'cancel', 'aria2_gid', 'missing-gid'] }];

		await Promise.all(processCleanerCommands(deps, entries));

		expect(store.acked).toHaveLength(0);
		expect(store.cleanerReports).toHaveLength(0);
	});

	test('only the FIRST action field in an entry is honored', async () => {
		const store = new FakeDownloaderStore();
		const { deps, unlinked } = makeDeps(store);
		const entries: WorkerCommandEntry[] = [{ id: '1-0', fields: ['action', 'delete', 'filename', 'first.grib2', 'action', 'delete', 'filename', 'second.grib2'] }];

		await Promise.all(processCleanerCommands(deps, entries));

		expect(unlinked).toEqual(['/downloads/first.grib2']);
	});
});

describe('pollCleanerCommands', () => {
	test('no entries: the cursor is unchanged and nothing is trimmed', async () => {
		const store = new FakeDownloaderStore();
		const { deps } = makeDeps(store);

		const nextId = await pollCleanerCommands(deps, '0-0');

		expect(nextId).toBe('0-0');
		expect(store.trimmedTo.size).toBe(0);
	});

	test('entries present: processes them and trims to the last id read', async () => {
		const store = new FakeDownloaderStore();
		store.workerCommandStreams.set('downloader1', [
			{ id: '1-0', fields: ['action', 'delete', 'filename', 'a.grib2'] },
			{ id: '2-0', fields: ['action', 'delete', 'filename', 'b.grib2'] },
		]);
		const { deps, unlinked } = makeDeps(store);

		const nextId = await pollCleanerCommands(deps, '0-0');

		expect(nextId).toBe('2-0');
		expect(unlinked).toEqual(['/downloads/a.grib2', '/downloads/b.grib2']);
		expect(store.trimmedTo.get('downloader1')).toBe('2-0');
	});
});

describe('runCleanerIpcLoop', () => {
	test('polls until the abort signal fires, then stops', async () => {
		const store = new FakeDownloaderStore();
		let ticks = 0;
		const controller = new AbortController();
		const { deps } = makeDeps(store, {
			sleep: async () => {
				ticks += 1;
				if (ticks >= 3) controller.abort();
			},
		});

		await runCleanerIpcLoop(deps, controller.signal, '0-0', 0);

		expect(ticks).toBe(3);
	});
});
