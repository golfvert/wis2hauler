import { describe, expect, test } from 'bun:test';
import { processEntry, runConsumerLoop, type ConsumerDeps } from '../consumer.ts';
import { FakeStore, FakeMqtt } from './fakes.ts';
import type { Wnm } from '../../wis2/wnm.ts';
import type { RawStreamEntry } from '../store.ts';
import { computeDownloaderId } from '../content-id.ts';
import type { SourceLogger } from '../../logging/logger.ts';

function fakeSourceLogger(): { logger: SourceLogger; warnCalls: Record<string, unknown>[] } {
	const warnCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: (d) => warnCalls.push(d), debug: () => {} }, warnCalls };
}

function fakeInfoLogger(): { logger: SourceLogger; infoCalls: Record<string, unknown>[] } {
	const infoCalls: Record<string, unknown>[] = [];
	return { logger: { info: (d) => infoCalls.push(d), warn: () => {}, debug: () => {} }, infoCalls };
}

function fakeReceivedLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

function fakeLog() {
	const lines: string[] = [];
	return { log: { log: (...a: unknown[]) => lines.push(a.join(' ')), error: (...a: unknown[]) => lines.push(a.join(' ')), warn: () => {} } as unknown as typeof console, lines };
}

function baseDeps(store: FakeStore, overrides: Partial<ConsumerDeps> = {}): ConsumerDeps {
	const { log } = fakeLog();
	return {
		store,
		queue: 'q1',
		overridelist: undefined,
		priorityGlobalCache: undefined,
		globalCacheMode: false,
		centreId: 'fr-meteofrance',
		publishClients: [],
		log,
		isDebugEnabled: () => false,
		sleep: async () => {}, // never actually wait in tests
		now: () => new Date('2026-01-01T00:00:00.000Z'),
		...overrides,
	};
}

const wnm = (id: string, extra: Partial<Wnm['properties']> = {}): Wnm => ({
	id,
	links: [{ rel: 'canonical', href: 'https://origin.example.org/file.grib2', length: 123 }],
	properties: { pubtime: '2026-01-01T00:00:00Z', data_id: `data-${id}`, ...extra },
});

function entry(topic: string, w: Wnm, id = '1-0'): RawStreamEntry {
	return { id, topic, payload: JSON.stringify(w) };
}

describe('processEntry', () => {
	test('an ignored classification (neither origin nor cache) does nothing', async () => {
		const store = new FakeStore();
		const deps = baseDeps(store);
		await processEntry(entry('metadata/a/wis2/fr-meteofrance/metadata/foo', wnm('m1')), deps);
		expect(store.claimedIds.size).toBe(0);
		expect(store.hashes.size).toBe(0);
	});

	test('malformed stream payload is logged, not thrown', async () => {
		const store = new FakeStore();
		const deps = baseDeps(store);
		await expect(processEntry({ id: '1-0', topic: 'origin/a/wis2/fr-meteofrance/data/foo', payload: '{bad' }, deps)).resolves.toBeUndefined();
	});

	test('"Order links" (Warn): an origin topic logs once', async () => {
		const store = new FakeStore();
		const { logger, warnCalls } = fakeSourceLogger();
		const deps = baseDeps(store, { orderLinksLog: logger });
		const w = wnm('m-warn-1');

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(warnCalls).toEqual([{ topic: 'origin/a/wis2/fr-meteofrance/data/foo', classification: 'origin' }]);
	});

	test('"Order links" (Warn): a cache topic with no priority-global-cache configured (cache-unprioritized) also logs', async () => {
		const store = new FakeStore();
		const { logger, warnCalls } = fakeSourceLogger();
		const deps = baseDeps(store, { orderLinksLog: logger, priorityGlobalCache: undefined });
		const w = wnm('m-warn-2');

		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', w, '1-1'), deps);

		expect(warnCalls).toEqual([{ topic: 'cache/a/wis2/fr-meteofrance/data/foo', classification: 'cache-unprioritized' }]);
	});

	test('"Order links" (Warn): a cache topic at priority position 0 also logs, with its position', async () => {
		const store = new FakeStore();
		const { logger, warnCalls } = fakeSourceLogger();
		const deps = baseDeps(store, { orderLinksLog: logger, priorityGlobalCache: ['fr-meteofrance', 'de-dwd'], sleep: async () => {} });
		const w = wnm('m-warn-3', { 'global-cache': 'fr-meteofrance' });

		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', w, '1-2'), deps);

		expect(warnCalls).toEqual([{ topic: 'cache/a/wis2/fr-meteofrance/data/foo', classification: 'cache', position: 0 }]);
	});

	test('"Order links" (Warn): a cache topic at a lower priority position does NOT log (only position 0 is wired to Warn)', async () => {
		const store = new FakeStore();
		const { logger, warnCalls } = fakeSourceLogger();
		const deps = baseDeps(store, { orderLinksLog: logger, priorityGlobalCache: ['fr-meteofrance', 'de-dwd'], sleep: async () => {} });
		const w = wnm('m-warn-4', { 'global-cache': 'de-dwd' });

		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', w, '1-3'), deps);

		expect(warnCalls).toHaveLength(0);
	});

	test('an unclaimed, not-already-complete origin message becomes a download job (HSET href="queue" + EXPIRE + XADD work queue)', async () => {
		const store = new FakeStore();
		const deps = baseDeps(store);
		const w = wnm('m2');
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		const hash = store.hashes.get(downloaderId);
		expect(hash).toBeDefined();
		expect(hash!['https://origin.example.org/file.grib2']).toBe('queue');
		expect(hash!['src:https://origin.example.org/file.grib2']).toBe('origin');
		expect(hash!.topic).toBe('origin/a/wis2/fr-meteofrance/data/foo');
		expect(hash!.published).toBe('2026-01-01T00:00:00Z');
		expect(hash!.attempt).toBe('1');
		expect(JSON.parse(hash!.wnm!).downloader_id).toBe(downloaderId); // stored wnm carries downloader_id, unlike the publish-only republish
		expect(store.expirations.get(downloaderId)).toBe(7200);

		expect(store.workQueue).toHaveLength(1);
		expect(store.workQueue[0]).toEqual({ queue: 'q1', downloaderId, href: 'https://origin.example.org/file.grib2', topic: 'origin/a/wis2/fr-meteofrance/data/foo', content: false });
	});

	test('nocache=true (cache:false) still downloads when global-cache mode is OFF -- nocache only gates the publish-only branch', async () => {
		const store = new FakeStore();
		const deps = baseDeps(store, { globalCacheMode: false });
		const w = wnm('m2b', { cache: false });

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.workQueue).toHaveLength(1);
		expect(store.releasedClaims).toHaveLength(0);
	});

	test('already-complete short-circuits before even attempting the claim', async () => {
		const store = new FakeStore();
		const deps = baseDeps(store);
		const w = wnm('m3');
		const downloaderId = computeDownloaderId(w);
		store.completeIds.add(downloaderId);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.claimedIds.size).toBe(0); // claimDownload never called
		expect(store.hashes.size).toBe(0);
	});

	test('losing the claim race with nocache=false records a wait entry on the SAME hash key pattern', async () => {
		const store = new FakeStore();
		const w = wnm('m4');
		const downloaderId = computeDownloaderId(w);
		store.claimedIds.add(downloaderId); // someone else already won

		const deps = baseDeps(store);
		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.workQueue).toHaveLength(0);
		const hash = store.hashes.get(downloaderId);
		expect(hash!['https://origin.example.org/file.grib2']).toBe('wait');
		expect(hash!['src:https://origin.example.org/file.grib2']).toBe('origin');
	});

	test('losing the claim race with nocache=true (cache:false) drops silently', async () => {
		const store = new FakeStore();
		const w = wnm('m5', { cache: false });
		const downloaderId = computeDownloaderId(w);
		store.claimedIds.add(downloaderId);

		const deps = baseDeps(store);
		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.hashes.size).toBe(0);
	});

	// DELIBERATE DEVIATION from the original, confirmed with the maintainer
	// 2026-09-11 (see override.ts's header comment): a bare
	// wnm.properties.cache === false, with no overridelist match, still
	// republishes the WNM on cache/... (WIS2-Guide-mandatory, still not
	// downloading the data) but no longer also emits the "Data granule
	// not cached" monitoring event -- the maintainer asked for that event removed
	// for this case specifically, having confirmed it WAS faithful to
	// flows.json. See the next test for the overridelist-match case,
	// where the monitor event is unchanged from the original.
	test('winning the claim via a bare cache:false (no override) republishes on cache/... but does NOT emit the monitor event', async () => {
		const store = new FakeStore();
		const w = wnm('m6', { cache: false });
		const pub1 = new FakeMqtt();
		const pub2 = new FakeMqtt();
		const deps = baseDeps(store, { globalCacheMode: true, publishClients: [pub1, pub2] });
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.workQueue).toHaveLength(0);
		expect(store.hashes.get(downloaderId)?.attempt).toBe('1'); // initAttempt only, no href/wnm/topic fields
		expect(store.hashes.get(downloaderId)?.wnm).toBeUndefined();
		expect(store.releasedClaims).toEqual([downloaderId]);

		expect(pub1.published).toHaveLength(1); // cache-topic republish ONLY -- no monitor event
		expect(pub1.published[0]!.topic).toBe('cache/a/wis2/fr-meteofrance/data/foo');
		const cacheMsg = JSON.parse(pub1.published[0]!.payload);
		expect(cacheMsg.downloader_id).toBeUndefined();
		expect(cacheMsg.properties['global-cache']).toBe('fr-meteofrance');
		expect(cacheMsg.id).toBeUndefined(); // no overridelist match -> uuid_cache was never generated (see override.ts)

		expect(pub2.published).toHaveLength(1);
	});

	test('winning the claim via an overridelist match on a cache:true/absent message publishes AND emits the monitor event -- this GC decided not to cache something the origin wanted cached', async () => {
		const store = new FakeStore();
		const w = wnm('m6z'); // properties.cache absent -> origin wanted it cached
		const pub1 = new FakeMqtt();
		const pub2 = new FakeMqtt();
		const deps = baseDeps(store, {
			globalCacheMode: true,
			publishClients: [pub1, pub2],
			overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }],
		});
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.workQueue).toHaveLength(0);
		expect(store.releasedClaims).toEqual([downloaderId]);

		expect(pub1.published).toHaveLength(2); // cache-topic republish + monitoring event
		expect(pub1.published[0]!.topic).toBe('cache/a/wis2/fr-meteofrance/data/foo');
		const cacheMsg = JSON.parse(pub1.published[0]!.payload);
		expect(typeof cacheMsg.id).toBe('string'); // overridelist match -> uuid_cache was generated (see override.ts)

		// originid is $split(wnmtopic,"/")[3] -- the centre-id segment only, NOT the full topic tail.
		expect(pub1.published[1]!.topic).toBe('monitor/a/wis2/fr-meteofrance');
		const monitorMsg = JSON.parse(pub1.published[1]!.payload);
		expect(monitorMsg.type).toBe('int.wmo.wis.wme.event.item.cache');
		expect(monitorMsg.source).toBe('fr-meteofrance');
		expect(monitorMsg.subject).toBe('fr-meteofrance');
		expect(monitorMsg.data.channel).toBe('origin/a/wis2/fr-meteofrance/data/foo');
		expect(monitorMsg.data.content.title).toBe('Data granule not cached');
		expect(monitorMsg.data.severity).toBe('INFO');

		expect(pub2.published).toHaveLength(2);
	});

	test('no local-broker configured (empty publishClients, 2026-09-14): claim bookkeeping still runs, but nothing is built or published', async () => {
		const store = new FakeStore();
		const w = wnm('m6x', { cache: false });
		// publishClients left at baseDeps' default: [].
		const deps = baseDeps(store, { globalCacheMode: true, overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }] });
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		// Claim bookkeeping is unconditional -- unaffected by whether
		// there's anything to publish to.
		expect(store.hashes.get(downloaderId)?.attempt).toBe('1');
		expect(store.releasedClaims).toEqual([downloaderId]);
		// Nothing to assert on the WNM/monitor payloads themselves -- with
		// no publishClients there's nowhere for them to land, which is
		// exactly the point: buildPublishOnlyMessages is never even called
		// (see processEntry's 'publish-only' case).
	});

	test('"Publish" (Info): a publish-only outcome logs the full republished notification, wnm and monitor included (2026-09-16)', async () => {
		const store = new FakeStore();
		const w = wnm('m6z'); // properties.cache absent -> origin wanted it cached
		const pub1 = new FakeMqtt();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, {
			globalCacheMode: true,
			publishClients: [pub1],
			overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }],
			publishLog: logger,
		});
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(infoCalls).toHaveLength(1);
		const call = infoCalls[0]!;
		expect(call.downloaderId).toBe(downloaderId);
		expect(call.role).toBe('SUBSCRIBER');
		expect(call.topic).toBe('cache/a/wis2/fr-meteofrance/data/foo');
		expect((call.wnm as Wnm).properties['global-cache']).toBe('fr-meteofrance');
		expect((call.wnm as { downloader_id?: string }).downloader_id).toBeUndefined();
		// overridelist matched -> the monitor event is also emitted and logged.
		expect(call.monitorTopic).toBe('monitor/a/wis2/fr-meteofrance');
		expect((call.monitor as { type: string }).type).toBe('int.wmo.wis.wme.event.item.cache');
	});

	test('"Publish" (Info): no monitor event fields when the monitor event isn\'t emitted (bare cache:false, no override)', async () => {
		const store = new FakeStore();
		const w = wnm('m6', { cache: false });
		const pub1 = new FakeMqtt();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { globalCacheMode: true, publishClients: [pub1], publishLog: logger });

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(infoCalls).toHaveLength(1);
		expect(infoCalls[0]!.monitorTopic).toBeUndefined();
		expect(infoCalls[0]!.monitor).toBeUndefined();
	});

	test('"Publish" (Info): not called at all when no local-broker is configured', async () => {
		const store = new FakeStore();
		const w = wnm('m6x', { cache: false });
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { globalCacheMode: true, publishLog: logger }); // publishClients: [] (default)

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(infoCalls).toHaveLength(0);
	});

	test('winning the claim via an overridelist match on a cache:false message publishes the WNM only -- no monitor event, since the origin already said not-cached', async () => {
		const store = new FakeStore();
		const w = wnm('m6y', { cache: false }); // origin ALSO already declared cache:false
		const pub1 = new FakeMqtt();
		const deps = baseDeps(store, {
			globalCacheMode: true,
			publishClients: [pub1],
			overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }],
		});
		const downloaderId = computeDownloaderId(w);

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(store.releasedClaims).toEqual([downloaderId]);
		expect(pub1.published).toHaveLength(1); // WNM republish only -- no monitor event
		expect(pub1.published[0]!.topic).toBe('cache/a/wis2/fr-meteofrance/data/foo');
		const cacheMsg = JSON.parse(pub1.published[0]!.payload);
		expect(typeof cacheMsg.id).toBe('string'); // overridelist match -> uuid_cache still generated, even though monitor isn't emitted
	});

	test('a rejecting publish (e.g. a disconnected local-broker client) is logged with explicit "local-broker publish failed" context, but still releases the claim', async () => {
		// Regression test for the 2026-09-11 bug (same class as
		// downloader/finishing.ts's fix, see that file's header): an
		// earlier version of this case rethrew the publish failure,
		// which let runConsumerLoop's generic per-entry catch abort
		// processEntry entirely -- silently skipping the releaseClaim()
		// call below. Since runConsumerLoop advances past this stream
		// entry unconditionally regardless of success/failure, a skipped
		// releaseClaim defeated the exact "don't leave it blocking a
		// future real download" fix the maintainer asked for. A down/reconnecting
		// local broker must never prevent the claim release.
		const store = new FakeStore();
		const w = wnm('m6c');
		const failingClient = {
			subscribe: async () => {},
			onMessage: () => {},
			publish: async () => {
				throw new Error('mqtt client not connected (cannot publish to cache/a/wis2/fr-meteofrance/data/foo)');
			},
			end: async () => {},
		};
		const { log, lines } = fakeLog();
		const deps = baseDeps(store, {
			globalCacheMode: true,
			publishClients: [failingClient],
			log,
			overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }],
		});

		const topic = 'origin/a/wis2/fr-meteofrance/data/foo';
		await processEntry(entry(topic, w), deps); // must resolve, not reject

		const errorLine = lines.find((l) => l.includes('local-broker publish failed'));
		expect(errorLine).toContain(
			'local-broker publish failed (publish-only outcome for',
		);
		expect(errorLine).toContain(
			'topics cache/a/wis2/fr-meteofrance/data/foo/monitor/a/wis2/fr-meteofrance): mqtt client not connected (cannot publish to cache/a/wis2/fr-meteofrance/data/foo)',
		);

		const downloaderId = computeDownloaderId(w);
		expect(store.releasedClaims).toContain(downloaderId);
	});

	test('a rejecting publish for a bare cache:false (no override, no monitor event) reports only the cache topic, not a stray "/monitor/..."', async () => {
		const store = new FakeStore();
		const w = wnm('m6d', { cache: false });
		const failingClient = {
			subscribe: async () => {},
			onMessage: () => {},
			publish: async () => {
				throw new Error('mqtt client not connected (cannot publish to cache/a/wis2/fr-meteofrance/data/foo)');
			},
			end: async () => {},
		};
		const { log, lines } = fakeLog();
		const deps = baseDeps(store, { globalCacheMode: true, publishClients: [failingClient], log });

		const topic = 'origin/a/wis2/fr-meteofrance/data/foo';
		await processEntry(entry(topic, w), deps); // must resolve, not reject

		const errorLine = lines.find((l) => l.includes('local-broker publish failed'));
		expect(errorLine).toContain(
			'topics cache/a/wis2/fr-meteofrance/data/foo): mqtt client not connected (cannot publish to cache/a/wis2/fr-meteofrance/data/foo)',
		);
		expect(errorLine).not.toContain('/monitor/a/wis2/');

		const downloaderId = computeDownloaderId(w);
		expect(store.releasedClaims).toContain(downloaderId);
	});

	test('an overridelist match stamps the republish/monitoring ids from override.ts and sets the reason', async () => {
		const store = new FakeStore();
		const w = wnm('m6b');
		const pub1 = new FakeMqtt();
		const deps = baseDeps(store, {
			globalCacheMode: true,
			publishClients: [pub1],
			overridelist: [{ topic: 'origin/a/wis2/fr-meteofrance/data/#' }],
		});

		await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

		const cacheMsg = JSON.parse(pub1.published[0]!.payload);
		expect(typeof cacheMsg.id).toBe('string');
		const monitorMsg = JSON.parse(pub1.published[1]!.payload);
		expect(typeof monitorMsg.id).toBe('string');
		expect(monitorMsg.data.content.description).toMatch(/topic matches/);
	});

	test('a cache-priority classification is staggered before the claim race', async () => {
		const store = new FakeStore();
		const sleeps: number[] = [];
		const w: Wnm = { ...wnm('m7'), properties: { ...wnm('m7').properties, 'global-cache': 'gb2' } };
		const deps = baseDeps(store, { priorityGlobalCache: ['gb1', 'gb2'], sleep: async (ms) => void sleeps.push(ms) });

		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', w), deps);

		expect(sleeps).toEqual([1000]); // position 1 -> CACHE_STAGGER_SECONDS[1] = 1s
		expect(store.workQueue).toHaveLength(1); // still proceeds to a normal claim afterwards
	});

	// "Decision" (Debug): added 2026-09-13 so global.log.level/.to actually
	// captures, per notification, what SUBSCRIBER decided -- see
	// ConsumerDeps.decisionLog's own doc comment for why this didn't
	// already exist in file-routed form, and for why this is DEBUG (a
	// new addition follows the maintainer's info/warn/debug policy from
	// scratch, unlike a ported call site) rather than info.
	describe('decisionLog', () => {
		test('a "download" action logs downloaderId/topic/href/action', async () => {
			const store = new FakeStore();
			const { logger, debugCalls } = fakeReceivedLogger();
			const deps = baseDeps(store, { decisionLog: logger });
			const w = wnm('d1');
			const downloaderId = computeDownloaderId(w);

			await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

			expect(debugCalls).toEqual([{ downloaderId, topic: 'origin/a/wis2/fr-meteofrance/data/foo', href: 'https://origin.example.org/file.grib2', action: 'download' }]);
		});

		test('a "wait" action (lost the claim race) logs action: wait', async () => {
			const store = new FakeStore();
			const w = wnm('d2');
			const downloaderId = computeDownloaderId(w);
			store.claimedIds.add(downloaderId);
			const { logger, debugCalls } = fakeReceivedLogger();
			const deps = baseDeps(store, { decisionLog: logger });

			await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

			expect(debugCalls).toEqual([{ downloaderId, topic: 'origin/a/wis2/fr-meteofrance/data/foo', href: 'https://origin.example.org/file.grib2', action: 'wait' }]);
		});

		test('a "drop" action (lost the claim race, nocache) still logs -- otherwise this outcome leaves no trace anywhere', async () => {
			const store = new FakeStore();
			const w = wnm('d3', { cache: false });
			const downloaderId = computeDownloaderId(w);
			store.claimedIds.add(downloaderId);
			const { logger, debugCalls } = fakeReceivedLogger();
			const deps = baseDeps(store, { decisionLog: logger });

			await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

			expect(debugCalls).toEqual([{ downloaderId, topic: 'origin/a/wis2/fr-meteofrance/data/foo', href: 'https://origin.example.org/file.grib2', action: 'drop' }]);
		});

		test('an "already-complete" action logs before short-circuiting', async () => {
			const store = new FakeStore();
			const w = wnm('d4');
			const downloaderId = computeDownloaderId(w);
			store.completeIds.add(downloaderId);
			const { logger, debugCalls } = fakeReceivedLogger();
			const deps = baseDeps(store, { decisionLog: logger });

			await processEntry(entry('origin/a/wis2/fr-meteofrance/data/foo', w), deps);

			expect(debugCalls).toEqual([{ downloaderId, topic: 'origin/a/wis2/fr-meteofrance/data/foo', href: 'https://origin.example.org/file.grib2', action: 'already-complete' }]);
		});

		test('an "ignore"-classified message logs nothing (never reaches the classify/claim decision at all)', async () => {
			const store = new FakeStore();
			const { logger, debugCalls } = fakeReceivedLogger();
			const deps = baseDeps(store, { decisionLog: logger });

			await processEntry(entry('metadata/a/wis2/fr-meteofrance/metadata/foo', wnm('d5')), deps);

			expect(debugCalls).toHaveLength(0);
		});
	});
});

// Origin-topic data_id lineage check -- see lineage.ts's header and
// ConsumerDeps.duplicateLog's doc comment. Regression coverage for
// the real ca-eccc-msc case the maintainer found via their separate
// "Sensor Global Cache" tool: an origin republishing the same
// data_id at the same (or non-newer) pubtime with rel=canonical,
// which computeDownloaderId's own pubtime-in-the-key formula fails
// to catch on its own.
describe('lineage (origin-topic data_id duplicate detection)', () => {
	const originTopic = 'origin/a/wis2/fr-meteofrance/data/foo';

	function wnmWithLinks(id: string, dataId: string, pubtime: string, rel: 'canonical' | 'update'): Wnm {
		return { id, links: [{ rel, href: 'https://origin.example.org/file.grib2' }], properties: { pubtime, data_id: dataId } };
	}

	test('the first message for a data_id is processed normally, not dropped', async () => {
		const store = new FakeStore();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { duplicateLog: logger });
		const w = wnmWithLinks('l1', 'data-l1', '2026-01-01T00:00:00Z', 'canonical');

		await processEntry(entry(originTopic, w), deps);

		expect(infoCalls).toHaveLength(0);
		expect(store.workQueue).toHaveLength(1);
	});

	test('a repeat: same data_id, same pubtime, rel=canonical both times -> silently dropped, logged to duplicateLog', async () => {
		const store = new FakeStore();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { duplicateLog: logger });
		const first = wnmWithLinks('l2a', 'data-l2', '2026-01-01T00:00:00Z', 'canonical');
		const second = wnmWithLinks('l2b', 'data-l2', '2026-01-01T00:00:00Z', 'canonical');

		await processEntry(entry(originTopic, first, '1-0'), deps);
		await processEntry(entry(originTopic, second, '1-1'), deps);

		expect(store.workQueue).toHaveLength(1); // only the first ever reached the claim/download logic
		expect(infoCalls).toHaveLength(1);
		expect(infoCalls[0]).toEqual({
			topic: originTopic,
			originCentreId: 'fr-meteofrance',
			dataId: 'data-l2',
			pubtime: '2026-01-01T00:00:00Z',
			reason: 'pubtime is not newer than a previously seen publish for this data_id',
		});
	});

	test('a repeat with a NEWER pubtime but still rel=canonical -> still a duplicate', async () => {
		const store = new FakeStore();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { duplicateLog: logger });
		const first = wnmWithLinks('l3a', 'data-l3', '2026-01-01T00:00:00Z', 'canonical');
		const second = wnmWithLinks('l3b', 'data-l3', '2026-01-02T00:00:00Z', 'canonical');

		await processEntry(entry(originTopic, first, '1-0'), deps);
		await processEntry(entry(originTopic, second, '1-1'), deps);

		expect(store.workQueue).toHaveLength(1);
		expect(infoCalls).toHaveLength(1);
		expect(infoCalls[0]!.reason).toMatch(/rel is not "update"/);
	});

	test('a repeat with a NEWER pubtime AND rel=update -> accepted as a legitimate update, not dropped', async () => {
		const store = new FakeStore();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { duplicateLog: logger });
		const first = wnmWithLinks('l4a', 'data-l4', '2026-01-01T00:00:00Z', 'canonical');
		const second = wnmWithLinks('l4b', 'data-l4', '2026-01-02T00:00:00Z', 'update');

		await processEntry(entry(originTopic, first, '1-0'), deps);
		await processEntry(entry(originTopic, second, '1-1'), deps);

		expect(infoCalls).toHaveLength(0);
		expect(store.workQueue).toHaveLength(2); // both processed through to the normal claim/download path
	});

	// The maintainer's explicit scope clarification: "It is normal to
	// received multiple identical data_id and same pubtime coming from
	// the various GC. So these are not duplicates!" -- two DIFFERENT
	// Global Caches relaying the exact same origin publish must never
	// be flagged against each other, however many of them there are.
	// (A single GC repeating ITS OWN publish is a separate case --
	// covered by the "misbehaving Global Cache" describe block below.)
	test('cache-topic traffic with identical data_id+pubtime from DIFFERENT relays is never flagged against each other', async () => {
		const store = new FakeStore();
		const { logger, infoCalls } = fakeInfoLogger();
		const deps = baseDeps(store, { duplicateLog: logger, priorityGlobalCache: ['gc-a', 'gc-b'], sleep: async () => {} });
		const fromA = { ...wnmWithLinks('c1a', 'data-c1', '2026-01-01T00:00:00Z', 'canonical'), properties: { pubtime: '2026-01-01T00:00:00Z', data_id: 'data-c1', 'global-cache': 'gc-a' } };
		const fromB = { ...wnmWithLinks('c1b', 'data-c1', '2026-01-01T00:00:00Z', 'canonical'), properties: { pubtime: '2026-01-01T00:00:00Z', data_id: 'data-c1', 'global-cache': 'gc-b' } };

		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', fromA, '1-0'), deps);
		await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', fromB, '1-1'), deps);

		expect(infoCalls).toHaveLength(0); // neither GC's publish counts as "prior history" for the other
		expect(store.lineage.size).toBe(0); // the origin-scoped history is untouched by cache-topic traffic
		expect(store.globalCacheLineage.size).toBe(2); // but each GC DOES get its own recorded history
	});

	// Added 2026-09-17 at the maintainer's explicit follow-up request:
	// a single Global Cache repeating ITS OWN publication of a data_id
	// without rel=update ("if a GC is pushing multiple times the same
	// data_id, same pubtime and no rel=update this it is a duplicate" /
	// "if a Global Cache goes crazy, it must be controlled...").
	describe('a single Global Cache repeating its own publication', () => {
		function cacheWnm(id: string, dataId: string, pubtime: string, globalCache: string, rel: 'canonical' | 'update'): Wnm {
			return { id, links: [{ rel, href: 'https://origin.example.org/file.grib2' }], properties: { pubtime, data_id: dataId, 'global-cache': globalCache } };
		}

		test('same data_id, same pubtime, rel=canonical both times, from the SAME GC -> dropped, logged with the globalCache label', async () => {
			const store = new FakeStore();
			const { logger, infoCalls } = fakeInfoLogger();
			const deps = baseDeps(store, { duplicateLog: logger, priorityGlobalCache: ['gc-a'], sleep: async () => {} });
			const first = cacheWnm('g1a', 'data-g1', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');
			const second = cacheWnm('g1b', 'data-g1', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');

			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', first, '1-0'), deps);
			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', second, '1-1'), deps);

			expect(infoCalls).toHaveLength(1);
			expect(infoCalls[0]).toEqual({
				topic: 'cache/a/wis2/fr-meteofrance/data/foo',
				dataId: 'data-g1',
				pubtime: '2026-01-01T00:00:00Z',
				reason: 'pubtime is not newer than a previously seen publish for this data_id',
				globalCache: 'gc-a',
			});
		});

		test('a newer pubtime but still rel=canonical, from the SAME GC -> still a duplicate', async () => {
			const store = new FakeStore();
			const { logger, infoCalls } = fakeInfoLogger();
			const deps = baseDeps(store, { duplicateLog: logger, priorityGlobalCache: ['gc-a'], sleep: async () => {} });
			const first = cacheWnm('g2a', 'data-g2', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');
			const second = cacheWnm('g2b', 'data-g2', '2026-01-02T00:00:00Z', 'gc-a', 'canonical');

			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', first, '1-0'), deps);
			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', second, '1-1'), deps);

			expect(infoCalls).toHaveLength(1);
			expect(infoCalls[0]!.reason).toMatch(/rel is not "update"/);
		});

		test('a newer pubtime WITH rel=update, from the SAME GC -> accepted, not dropped', async () => {
			const store = new FakeStore();
			const { logger, infoCalls } = fakeInfoLogger();
			const deps = baseDeps(store, { duplicateLog: logger, priorityGlobalCache: ['gc-a'], sleep: async () => {} });
			const first = cacheWnm('g3a', 'data-g3', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');
			const second = cacheWnm('g3b', 'data-g3', '2026-01-02T00:00:00Z', 'gc-a', 'update');

			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', first, '1-0'), deps);
			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', second, '1-1'), deps);

			expect(infoCalls).toHaveLength(0);
		});

		test('applies even with no priority-global-cache configured (cache-unprioritized classification)', async () => {
			const store = new FakeStore();
			const { logger, infoCalls } = fakeInfoLogger();
			const deps = baseDeps(store, { duplicateLog: logger }); // priorityGlobalCache: undefined (default)
			const first = cacheWnm('g4a', 'data-g4', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');
			const second = cacheWnm('g4b', 'data-g4', '2026-01-01T00:00:00Z', 'gc-a', 'canonical');

			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', first, '1-0'), deps);
			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', second, '1-1'), deps);

			expect(infoCalls).toHaveLength(1);
		});

		test('a cache-topic message with no "global-cache" label at all is skipped -- nothing to key the history on', async () => {
			const store = new FakeStore();
			const { logger, infoCalls } = fakeInfoLogger();
			const deps = baseDeps(store, { duplicateLog: logger });
			const noLabel: Wnm = { id: 'g5', links: [{ rel: 'canonical', href: 'https://origin.example.org/file.grib2' }], properties: { pubtime: '2026-01-01T00:00:00Z', data_id: 'data-g5' } };

			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', noLabel), deps);
			await processEntry(entry('cache/a/wis2/fr-meteofrance/data/foo', noLabel), deps);

			expect(infoCalls).toHaveLength(0);
			expect(store.globalCacheLineage.size).toBe(0);
		});
	});
});

describe('runConsumerLoop', () => {
	test('processes entries from the store and stops once the signal is aborted', async () => {
		const store = new FakeStore();
		const w = wnm('loop-1');
		const entries: RawStreamEntry[] = [entry('origin/a/wis2/fr-meteofrance/data/foo', w, '5-0')];
		let reads = 0;
		store.readRawMessages = async (_queue, _lastId, _count) => {
			reads++;
			if (reads === 1) return entries;
			// A real (small) delay so this fake behaves like a live Redis call
			// that yields to the event loop -- without it the loop can spin
			// fast enough on synchronously-resolved promises to starve the
			// test's own setTimeout below, and never see the abort.
			await new Promise((r) => setTimeout(r, 5));
			return [];
		};

		const ac = new AbortController();
		const deps = baseDeps(store);
		const loopPromise = runConsumerLoop(deps, ac.signal, '0-0', 10, 10);

		// Give the loop a couple of ticks to consume the one batch, then stop it.
		await new Promise((r) => setTimeout(r, 50));
		ac.abort();
		await loopPromise;

		expect(store.workQueue).toHaveLength(1);
		expect(reads).toBeGreaterThanOrEqual(1);
	});

	test('entries missing topic or payload are skipped without calling processEntry', async () => {
		const store = new FakeStore();
		let calls = 0;
		store.readRawMessages = async () => {
			calls++;
			if (calls === 1) return [{ id: '1-0', topic: '', payload: '' }];
			await new Promise((r) => setTimeout(r, 5));
			return [];
		};

		const ac = new AbortController();
		const deps = baseDeps(store);
		const loopPromise = runConsumerLoop(deps, ac.signal, '0-0', 10, 10);
		await new Promise((r) => setTimeout(r, 30));
		ac.abort();
		await loopPromise;

		expect(store.hashes.size).toBe(0);
	});

	test('a batch is processed CONCURRENTLY -- a staggered (cache-priority) entry must not delay unrelated entries behind it', async () => {
		// Regression test for the 2026-09-11 bug (see runConsumerLoop's
		// own doc comment): a literal `for (const entry of entries) {
		// await processEntry(...); }` port would have awaited a
		// cache-priority entry's full 1-8s stagger sleep (order-links.ts's
		// CACHE_STAGGER_SECONDS) to completion before even STARTING any
		// other entry later in the same batch of up to 500 -- the real
		// original (mqtt-in dispatching each message independently) never
		// serializes unrelated messages behind one another like that.
		const staggeredWnm = wnm('stag-1', { 'global-cache': 'other-centre' });
		const staggeredEntry = entry('cache/a/wis2/other-centre/data/foo', staggeredWnm, '1-0');
		const fastEntry = entry('origin/a/wis2/fr-meteofrance/data/bar', wnm('fast-1'), '2-0');

		const store = new FakeStore();
		let reads = 0;
		store.readRawMessages = async () => {
			reads++;
			if (reads === 1) return [staggeredEntry, fastEntry];
			await new Promise((r) => setTimeout(r, 5));
			return [];
		};

		let fastClaimedAt: number | null = null;
		const originalClaim = store.claimDownload.bind(store);
		store.claimDownload = async (downloaderId: string) => {
			if (downloaderId.includes('fast-1')) fastClaimedAt = Date.now();
			return originalClaim(downloaderId);
		};

		const startedAt = Date.now();
		// Scale the stagger's real wait down (20x) so the test stays fast
		// while still proving genuine concurrency, not just a short delay.
		const deps = baseDeps(store, {
			priorityGlobalCache: ['other-centre'], // position 0 -> CACHE_STAGGER_SECONDS[0] = 1s
			sleep: (ms: number) => new Promise((r) => setTimeout(r, ms / 20)),
		});

		const ac = new AbortController();
		const loopPromise = runConsumerLoop(deps, ac.signal, '0-0', 10, 10);
		await new Promise((r) => setTimeout(r, 80));
		ac.abort();
		await loopPromise;

		expect(fastClaimedAt).not.toBeNull();
		expect(fastClaimedAt! - startedAt).toBeLessThan(40); // the fast entry claimed almost immediately, NOT after the staggered entry's ~50ms (1000ms/20) sleep
		expect(store.workQueue.some((j) => j.downloaderId.includes('fast-1'))).toBe(true);
		expect(store.workQueue.some((j) => j.downloaderId.includes('stag-1'))).toBe(true); // the staggered entry still completes, just later
	});
});
