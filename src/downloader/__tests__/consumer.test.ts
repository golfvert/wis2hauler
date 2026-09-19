import { describe, expect, test } from 'bun:test';
import { InFlightCounter, handleAriaNotification, pollOnce, processQueueEntry, runConsumerLoop, type ConsumerDeps } from '../consumer.ts';
import type { DecodeWriteIO } from '../decode-write.ts';
import type { AriaStartDeps } from '../aria-start.ts';
import type { CompleteDeps } from '../complete.ts';
import type { FinishingDeps } from '../finishing.ts';
import type { ErrorRetryDeps } from '../error-retry.ts';
import type { Aria2Client, Aria2Notification, Aria2Status } from '../aria2.ts';
import type { HashConfig, HashIO } from '../hash.ts';
import type { MqttLike } from '../../mqtt/types.ts';
import type { WorkQueueEntry } from '../store.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; infoCalls: Record<string, unknown>[]; warnCalls: Record<string, unknown>[]; debugCalls: Record<string, unknown>[] } {
	const infoCalls: Record<string, unknown>[] = [];
	const warnCalls: Record<string, unknown>[] = [];
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: (d) => infoCalls.push(d), warn: (d) => warnCalls.push(d), debug: (d) => debugCalls.push(d) }, infoCalls, warnCalls, debugCalls };
}

function makeDecodeWriteIo(overrides: Partial<DecodeWriteIO> = {}): DecodeWriteIO {
	return {
		mkdirRecursive: () => {},
		join: (...parts) => parts.join('/'),
		dirname: (fp) => fp.split('/').slice(0, -1).join('/'),
		writeFileSync: () => {},
		gunzipSync: (data) => data,
		base64Decode: (v) => new TextEncoder().encode(Buffer.from(v, 'base64').toString('utf8')),
		utf8Encode: (v) => new TextEncoder().encode(v),
		hashBase64: () => 'digest',
		randomStreamSuffix: () => '999999',
		warn: () => {},
		...overrides,
	};
}

function makeHashIo(overrides: Partial<HashIO> = {}): HashIO {
	return {
		statSize: () => 42,
		dirname: (fp) => fp.split('/').slice(0, -1).join('/'),
		basename: (fp) => fp.split('/').pop() ?? '',
		join: (...parts) => parts.join('/'),
		relative: (from, to) => (to.startsWith(`${from}/`) ? to.slice(from.length + 1) : to),
		mkdirRecursive: () => {},
		exists: () => false,
		unlinkSync: () => {},
		renameSync: () => {},
		unlinkAsync: async () => {},
		hashFileBase64: async () => 'digest',
		isUnsupportedHashMethod: () => false,
		now: () => 1700000000000,
		uploadToS3: async () => {},
		warn: () => {},
		error: () => {},
		...overrides,
	};
}

const hashConfig: HashConfig = {
	worker: 'downloader1',
	downloadUrlBase: 'https://downloader.example.com',
	renameToDate: false,
	renameToTopic: false,
	renameToS3: false,
	ariaDownload: '/downloads',
};

function makeMqttClient(): { client: MqttLike; published: { topic: string; payload: string }[] } {
	const published: { topic: string; payload: string }[] = [];
	const client: MqttLike = {
		subscribe: async () => {},
		onMessage: () => {},
		publish: async (topic: string, payload: string) => {
			published.push({ topic, payload });
		},
		end: async () => {},
	};
	return { client, published };
}

function makeDeps(store: FakeDownloaderStore, overrides: Partial<ConsumerDeps> = {}): ConsumerDeps {
	const ariaStart: AriaStartDeps = {
		store,
		worker: 'downloader1',
		aria2: { addUri: async () => 'aria2-real-gid' } as unknown as Aria2Client,
		credentials: () => undefined,
		checkCertificate: undefined,
		randomStreamSuffix: () => '111111',
	};
	const complete: CompleteDeps = { store, worker: 'downloader1', hashConfig, hashIo: makeHashIo(), newUuid: () => 'fresh-uuid' };
	const finishing: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [] };
	const errorRetry: ErrorRetryDeps = { store, queue: 'wis2gc:downloader-queue', worker: 'downloader1', ariaStart, sleep: async () => {}, mintRequeueId: () => 'requeue-1' };
	return {
		store,
		queue: 'wis2gc:downloader-queue',
		worker: 'downloader1',
		ariaInQueue: 5,
		inFlight: new InFlightCounter(),
		ariaDownloadDir: '/downloads',
		decodeWriteIo: makeDecodeWriteIo(),
		ariaStart,
		complete,
		finishing,
		errorRetry,
		log: { ...console, error: () => {} },
		...overrides,
	};
}

function embeddedWnmRecord(href: string) {
	return {
		type: 'Feature',
		downloader_id: 'wis2:centre:abc',
		geometry: null,
		properties: { pubtime: '2023-09-08T12:00:00Z', content: { encoding: 'utf-8', value: 'hello' } },
		links: [{ rel: 'canonical', href }],
	};
}


describe('InFlightCounter', () => {
	test('adds and releases, clamped at 0', () => {
		const counter = new InFlightCounter();
		expect(counter.get()).toBe(0);
		counter.release();
		expect(counter.get()).toBe(0);
		counter.add(3);
		expect(counter.get()).toBe(3);
		counter.release();
		counter.release();
		expect(counter.get()).toBe(1);
	});
});

describe('processQueueEntry', () => {
	test('content=true, embedded content decodes and writes: acks, hashes OK, and finishes', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(embeddedWnmRecord(href)), topic: 'origin/a/wis2/centre/foo', [href]: 'queue' });
		const { client, published } = makeMqttClient();
		const deps = makeDeps(store, { finishing: { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client] } });
		const entry: WorkQueueEntry = { id: '1694198400000-0', downloaderId: 'wis2:centre:abc', href, topic: 'origin/a/wis2/centre/foo', content: 'true' };

		await processQueueEntry(deps, entry);

		expect(store.acked).toHaveLength(1);
		expect(store.completeIds.has('wis2:centre:abc')).toBe(true);
		expect(published).toHaveLength(1);
	});

	test('content=true but the embedded content fails to decode: falls through to a real aria2 download', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify({ properties: {} }), topic: 'origin/a/wis2/centre/foo' });
		const deps = makeDeps(store);
		const entry: WorkQueueEntry = { id: '1694198400000-0', downloaderId: 'wis2:centre:abc', href: 'https://example.com/g.grib2', topic: 'origin/a/wis2/centre/foo', content: 'true' };

		await processQueueEntry(deps, entry);

		expect(store.streamEntries.size).toBe(1);
		expect(store.aria2GidRecords.has('downloader1:aria2-real-gid')).toBe(true);
	});

	test('content=false: goes straight to a real aria2 download, decode-write is never consulted', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);
		const entry: WorkQueueEntry = { id: '1694198400000-0', downloaderId: 'wis2:centre:abc', href: 'https://example.com/h.grib2', topic: 'origin/a/wis2/centre/foo', content: 'false' };

		await processQueueEntry(deps, entry);

		expect(store.streamEntries.size).toBe(1);
		expect(store.aria2GidRecords.has('downloader1:aria2-real-gid')).toBe(true);
	});

	test('a synthetic gid that fails the ack "First ?" sanity check takes no further action', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(embeddedWnmRecord(href)) });
		// A non-numeric entry id makes the minted synthetic gid fail FIRST_REGEX.
		const deps = makeDeps(store);
		const entry: WorkQueueEntry = { id: 'not-a-stream-id', downloaderId: 'wis2:centre:abc', href, topic: 'origin/a/wis2/centre/foo', content: 'true' };

		await processQueueEntry(deps, entry);

		expect(store.acked).toHaveLength(0);
		expect(store.completeIds.size).toBe(0);
	});

});

describe('handleAriaNotification', () => {
	function seedRealDownloadRecord(store: FakeDownloaderStore, gid: string, href: string, downloaderId: string) {
		store.aria2GidRecords.set(`downloader1:${gid}`, [
			'stream_id',
			'1694198400000-0-999999',
			'downloader_id',
			downloaderId,
			'download_entry_id',
			'1694198400000-0',
			'href',
			href,
			'filename',
			'abc_f.grib2',
		]);
		store.hashes.set(downloaderId, {
			wnm: JSON.stringify({ type: 'Feature', downloader_id: downloaderId, geometry: null, properties: { pubtime: '2023-09-08T12:00:00Z' }, links: [{ rel: 'canonical', href }] }),
			topic: 'origin/a/wis2/centre/foo',
			[href]: 'queue',
		});
	}

	function seedRealDownloadRecordWithIntegrity(store: FakeDownloaderStore, gid: string, href: string, downloaderId: string) {
		store.aria2GidRecords.set(`downloader1:${gid}`, [
			'stream_id',
			'1694198400000-0-999999',
			'downloader_id',
			downloaderId,
			'download_entry_id',
			'1694198400000-0',
			'href',
			href,
			'filename',
			'abc_f.grib2',
		]);
		store.hashes.set(downloaderId, {
			wnm: JSON.stringify({
				type: 'Feature',
				downloader_id: downloaderId,
				geometry: null,
				properties: { pubtime: '2023-09-08T12:00:00Z', integrity: { method: 'sha256', value: 'expected-digest' } },
				links: [{ rel: 'canonical', href }],
			}),
			topic: 'origin/a/wis2/centre/foo',
			[href]: 'queue',
		});
	}

	test('"Correct ?" (Warn): a HASH_NOK outcome (post-download hash mismatch) logs once with the outcome', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		seedRealDownloadRecordWithIntegrity(store, 'gid-hashnok', href, 'wis2:centre:abc');
		const { logger, warnCalls } = fakeSourceLogger();
		const deps = makeDeps(store, {
			correctLog: logger,
			complete: { store, worker: 'downloader1', hashConfig, hashIo: makeHashIo({ hashFileBase64: async () => 'wrong-digest' }), newUuid: () => 'fresh-uuid' },
		});
		const notification: Aria2Notification = { method: 'aria2.onDownloadComplete', gid: 'gid-hashnok' };
		const status: Aria2Status = { status: 'complete', files: [{ path: '/downloads/abc_f.grib2' }] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(warnCalls).toEqual([{ downloaderId: 'wis2:centre:abc', hashOutcome: 'HASH_NOK' }]);
	});

	test('a Complete notification for a real download acks it and runs completion', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		seedRealDownloadRecord(store, 'gid-1', href, 'wis2:centre:abc');
		const deps = makeDeps(store);
		const notification: Aria2Notification = { method: 'aria2.onDownloadComplete', gid: 'gid-1' };
		const status: Aria2Status = { status: 'complete', files: [{ path: '/downloads/abc_f.grib2' }] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(store.acked).toHaveLength(1);
		expect(store.completeIds.has('wis2:centre:abc')).toBe(true);
	});

	test('"Output - Complete" (Debug): logs once, before the ack, with the gid', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		seedRealDownloadRecord(store, 'gid-debug-1', href, 'wis2:centre:abc');
		const { logger, debugCalls } = fakeSourceLogger();
		const deps = makeDeps(store, { outputCompleteLog: logger });
		const notification: Aria2Notification = { method: 'aria2.onDownloadComplete', gid: 'gid-debug-1' };
		const status: Aria2Status = { status: 'complete', files: [{ path: '/downloads/abc_f.grib2' }] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(debugCalls).toEqual([{ gid: 'gid-debug-1', status: 'complete' }]);
	});

	test('a Complete notification whose status is not actually complete is ignored', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);
		const notification: Aria2Notification = { method: 'aria2.onDownloadComplete', gid: 'gid-1' };
		const status: Aria2Status = { status: 'active', files: [{ path: '/downloads/abc_f.grib2' }] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(store.acked).toHaveLength(0);
	});

	test("a Complete notification whose file path doesn't look like a real download is ignored", async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);
		const notification: Aria2Notification = { method: 'aria2.onDownloadComplete', gid: 'gid-1' };
		const status: Aria2Status = { status: 'complete', files: [{ path: '/somewhere-else/abc_f.grib2' }] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(store.acked).toHaveLength(0);
	});

	test('an Error notification acks, releases an in-flight slot, and reports+retries', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		seedRealDownloadRecord(store, 'gid-2', href, 'wis2:centre:abc');
		const inFlight = new InFlightCounter();
		inFlight.add(1);
		const deps = makeDeps(store, { inFlight });
		const notification: Aria2Notification = { method: 'aria2.onDownloadError', gid: 'gid-2' };
		const status: Aria2Status = { status: 'error', files: [] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(store.acked).toHaveLength(1);
		expect(inFlight.get()).toBe(0);
		expect(store.cleanerReports).toEqual([{ worker: 'downloader1', report: JSON.stringify(['type', 'download_error', 'topic', '']) }]);
	});

	test('"Output - Error" (Debug): logs once, before the ack, with the gid', async () => {
		const store = new FakeDownloaderStore();
		const href = 'https://example.com/f.grib2';
		seedRealDownloadRecord(store, 'gid-debug-2', href, 'wis2:centre:abc');
		const { logger, debugCalls } = fakeSourceLogger();
		const deps = makeDeps(store, { outputErrorLog: logger });
		const notification: Aria2Notification = { method: 'aria2.onDownloadError', gid: 'gid-debug-2' };
		const status: Aria2Status = { status: 'error', files: [] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(debugCalls).toEqual([{ gid: 'gid-debug-2', status: 'error' }]);
	});

	test('an Error notification whose status is not actually an error is ignored', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);
		const notification: Aria2Notification = { method: 'aria2.onDownloadError', gid: 'gid-2' };
		const status: Aria2Status = { status: 'active', files: [] };

		await handleAriaNotification(deps, notification, async () => status);

		expect(store.acked).toHaveLength(0);
	});
});

describe('pollOnce', () => {
	test('does nothing when the queue is empty', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);

		await pollOnce(deps);

		expect(store.streamEntries.size).toBe(0);
	});

	test('does nothing when already at the in-flight ceiling (ariaInQueue)', async () => {
		const store = new FakeDownloaderStore();
		store.queueLengths.set('wis2gc:downloader-queue', 10);
		store.workQueues.set('wis2gc:downloader-queue', [{ id: '1-0', downloaderId: 'wis2:centre:abc', href: 'https://example.com/a.grib2', topic: 'x', content: 'false' }]);
		const inFlight = new InFlightCounter();
		inFlight.add(5);
		const deps = makeDeps(store, { ariaInQueue: 5, inFlight });

		await pollOnce(deps);

		expect(store.streamEntries.size).toBe(0);
	});

	test('reads and processes entries when the queue is non-empty and under the ceiling', async () => {
		const store = new FakeDownloaderStore();
		store.queueLengths.set('wis2gc:downloader-queue', 1);
		store.workQueues.set('wis2gc:downloader-queue', [{ id: '1-0', downloaderId: 'wis2:centre:abc', href: 'https://example.com/a.grib2', topic: 'x', content: 'false' }]);
		const deps = makeDeps(store);

		await pollOnce(deps);

		expect(store.streamEntries.size).toBe(1);
		expect(deps.inFlight.get()).toBe(1);
	});

	test('an error processing one entry is logged, not thrown, and does not stop the batch', async () => {
		const store = new FakeDownloaderStore();
		store.queueLengths.set('wis2gc:downloader-queue', 1);
		store.workQueues.set('wis2gc:downloader-queue', [{ id: '1-0', downloaderId: 'wis2:centre:abc', href: 'https://example.com/a.grib2', topic: 'x', content: 'false' }]);
		const errors: string[] = [];
		const deps = makeDeps(store, {
			ariaStart: {
				store,
				worker: 'downloader1',
				aria2: {
					addUri: async () => {
						throw new Error('aria2 unreachable');
					},
				} as unknown as Aria2Client,
				credentials: () => undefined,
				checkCertificate: undefined,
				randomStreamSuffix: () => '111111',
			},
			log: { ...console, error: (m: string) => errors.push(m) },
		});

		await pollOnce(deps);

		expect(errors).toHaveLength(1);
	});

	test('processes every entry in a batch CONCURRENTLY, not one at a time -- a slow entry must not delay the others', async () => {
		// Regression test for the 2026-09-11 bug (see consumer.ts's own
		// doc comment on pollOnce): a literal `for (const entry of
		// entries) { await processQueueEntry(...); }` port would have
		// awaited entry A's full ~6-round-trip chain (including this
		// slow addUri) to completion before entry B's FIRST round trip
		// even started -- so with a 200ms-slow entry A and an instant
		// entry B, a serialized implementation takes >= 200ms AND B's
		// own registerStreamEntry only happens after that. The real
		// original (Node-RED's "Href" node returning an array of
		// messages) dispatches every entry's chain concurrently, so the
		// whole batch should finish in roughly the SLOWEST single
		// entry's time, not the SUM of all entries' times.
		const store = new FakeDownloaderStore();
		store.queueLengths.set('wis2gc:downloader-queue', 2);
		store.workQueues.set('wis2gc:downloader-queue', [
			{ id: '1-0', downloaderId: 'wis2:centre:slow', href: 'https://example.com/slow.grib2', topic: 'x', content: 'false' },
			{ id: '1-1', downloaderId: 'wis2:centre:fast', href: 'https://example.com/fast.grib2', topic: 'x', content: 'false' },
		]);

		const SLOW_MS = 200;
		let fastEntryStartedAt: number | null = null;
		const startedAt = Date.now();

		const deps = makeDeps(store, {
			ariaStart: {
				store,
				worker: 'downloader1',
				aria2: {
					addUri: async (href: string) => {
						if (href.includes('slow')) {
							await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
							return 'gid-slow';
						}
						fastEntryStartedAt = Date.now();
						return 'gid-fast';
					},
				} as unknown as Aria2Client,
				credentials: () => undefined,
				checkCertificate: undefined,
				randomStreamSuffix: () => '111111',
			},
		});

		await pollOnce(deps);

		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeLessThan(SLOW_MS + 100); // well under 2x SLOW_MS -- proves the two entries ran concurrently, not summed
		expect(fastEntryStartedAt).not.toBeNull();
		expect(fastEntryStartedAt! - startedAt).toBeLessThan(100); // the fast entry's own addUri call started almost immediately, NOT after the slow entry's 200ms finished
		expect(store.streamEntries.size).toBe(2); // both entries still got fully processed
	});
});

describe('runConsumerLoop', () => {
	test('polls until the abort signal fires, then stops', async () => {
		const store = new FakeDownloaderStore();
		const deps = makeDeps(store);
		let ticks = 0;
		const controller = new AbortController();

		await runConsumerLoop(
			deps,
			controller.signal,
			async () => {
				ticks += 1;
				if (ticks >= 3) controller.abort();
			},
			0,
		);

		expect(ticks).toBe(3);
	});
});
