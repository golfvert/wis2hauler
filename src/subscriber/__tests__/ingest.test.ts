import { describe, expect, test } from 'bun:test';
import { createIngestHandler, createIngestStats, ORIGIN_CORE_BLACKLIST_RULE, ORIGIN_METADATA_BLACKLIST_RULE, type IngestDeps } from '../ingest.ts';
import { FakeStore } from './fakes.ts';
import type { SourceLogger } from '../../logging/logger.ts';

function fakeLog() {
	const lines: string[] = [];
	return { log: { log: (...a: unknown[]) => lines.push(a.join(' ')), error: (...a: unknown[]) => lines.push(a.join(' ')), warn: () => {} } as unknown as typeof console, lines };
}

function fakeReceivedLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

function baseDeps(store: FakeStore, overrides: Partial<IngestDeps> = {}): IngestDeps {
	const { log } = fakeLog();
	return {
		store,
		queue: 'q1',
		blacklist: [],
		sourceLabel: 'GB1',
		preDelayMs: 0,
		sleep: async () => {},
		now: () => 1_700_000_000_000,
		log,
		isDebugEnabled: () => false,
		...overrides,
	};
}

const wnm = (id: string) => JSON.stringify({ id, links: [], properties: { pubtime: '2026-01-01T00:00:00Z', data_id: 'x' } });

describe('createIngestHandler', () => {
	test('a new, non-blacklisted message is claimed and appended to the raw stream', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-1')));

		expect(store.rawStream).toHaveLength(1);
		expect(store.rawStream[0]!.topic).toBe('origin/a/wis2/fr-meteofrance/data/foo');
		expect(stats).toEqual({ received: 1, unchanged: 0, blacklisted: 0, duplicate: 0, malformed: 0, ingested: 1 });
	});

	test('an unchanged payload on the same topic is dropped by rbe before the blacklist check', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);
		const payload = Buffer.from(wnm('msg-rbe'));

		await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);
		await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);

		expect(store.rawStream).toHaveLength(1);
		expect(stats.unchanged).toBe(1);
		expect(store.messageIds.size).toBe(1); // second call never reached dedup
	});

	test('a changed payload on the same topic passes rbe (only unchanged repeats are dropped)', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-a')));
		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-b')));

		expect(store.rawStream).toHaveLength(2);
		expect(stats.unchanged).toBe(0);
	});

	test('rbe tracks per topic -- an identical payload STRING on a different topic is not suppressed by rbe (it is a distinct wnm.id, so it also clears the separate dedup step)', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-shared-a')));
		await handler('origin/a/wis2/fr-meteofrance/data/bar', Buffer.from(wnm('msg-shared-b')));

		expect(store.rawStream).toHaveLength(2);
		expect(stats.unchanged).toBe(0); // rbe (per-topic, raw-payload) never suppressed either message
	});

	test('a blacklisted topic is dropped before dedup/append', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store, { blacklist: ['+/+/+/+/+/recommended/#'] }), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-2')));

		expect(store.rawStream).toHaveLength(0);
		expect(store.messageIds.size).toBe(0); // never got as far as dedup
		expect(stats.blacklisted).toBe(1);
	});

	// ORIGIN_CORE_BLACKLIST_RULE / ORIGIN_METADATA_BLACKLIST_RULE (see
	// ingest.ts's own doc comment, wired in run.ts): the message-ingest-time
	// safeguard that replaced the old config-time whitelist rewrite (see
	// ../../config/topics.ts's removal comment). The key property under
	// test here is that this runs against the topic the message actually
	// ARRIVED on -- so it drops these messages even though the ingest
	// handler doesn't otherwise care what the whitelist was subscribed
	// to (this handler only ever sees what a real broker delivered).
	describe('the origin core/metadata safeguard (global-cache mode off)', () => {
		const blacklist = [ORIGIN_CORE_BLACKLIST_RULE, ORIGIN_METADATA_BLACKLIST_RULE];

		test('drops a core-data notification received straight from origin', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const handler = createIngestHandler(baseDeps(store, { blacklist }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/core/weather/surface', Buffer.from(wnm('msg-core')));

			expect(store.rawStream).toHaveLength(0);
			expect(stats.blacklisted).toBe(1);
		});

		test('drops a metadata notification received straight from origin', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const handler = createIngestHandler(baseDeps(store, { blacklist }), stats);

			await handler('origin/a/wis2/fr-meteofrance/metadata', Buffer.from(wnm('msg-metadata')));

			expect(store.rawStream).toHaveLength(0);
			expect(stats.blacklisted).toBe(1);
		});

		test('still ingests recommended data from origin, and core data already republished under cache/...', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const handler = createIngestHandler(baseDeps(store, { blacklist }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/recommended/x', Buffer.from(wnm('msg-recommended')));
			await handler('cache/a/wis2/fr-meteofrance/data/core/weather/surface', Buffer.from(wnm('msg-cache-core')));

			expect(store.rawStream).toHaveLength(2);
			expect(stats.blacklisted).toBe(0);
		});
	});

	test('blacklist matching strips the replay/a/wis2/... wrapper first', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store, { blacklist: ['+/+/+/+/+/recommended/#'] }), stats);

		await handler('replay/a/wis2/fr-meteofrance/some-uuid/origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-3')));

		expect(stats.blacklisted).toBe(1);
		expect(store.rawStream).toHaveLength(0);
	});

	test('malformed JSON is dropped and logged, not thrown', async () => {
		const store = new FakeStore();
		const { log, lines } = fakeLog();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store, { log }), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from('{not json'));

		expect(store.rawStream).toHaveLength(0);
		expect(stats.malformed).toBe(1);
		expect(lines.some((l) => l.includes('malformed'))).toBe(true);
	});

	test('a WNM with no id is treated as malformed', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(JSON.stringify({ links: [], properties: {} })));

		expect(stats.malformed).toBe(1);
		expect(store.rawStream).toHaveLength(0);
	});

	test('a repeated wnm.id on DIFFERENT topics (so rbe does not intervene) is deduped and not re-appended', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('same-id')));
		await handler('origin/a/wis2/fr-meteofrance/data/bar', Buffer.from(wnm('same-id')));

		expect(store.rawStream).toHaveLength(1);
		expect(stats.ingested).toBe(1);
		expect(stats.duplicate).toBe(1);
	});

	test('preDelayMs (GB2) waits before rbe/blacklist/dedup, via the injectable sleep', async () => {
		const store = new FakeStore();
		const stats = createIngestStats();
		const waited: number[] = [];
		const handler = createIngestHandler(
			baseDeps(store, {
				preDelayMs: 2000,
				sleep: async (ms) => void waited.push(ms),
			}),
			stats,
		);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-delayed')));

		expect(waited).toEqual([2000]);
		expect(store.rawStream).toHaveLength(1);
	});

	test('appendRawMessage receives the injected now() as the timestamp', async () => {
		const store = new FakeStore();
		const timestamps: number[] = [];
		const original = store.appendRawMessage.bind(store);
		store.appendRawMessage = async (queue, topic, payload, timestampMs) => {
			timestamps.push(timestampMs);
			return original(queue, topic, payload, timestampMs);
		};
		const stats = createIngestStats();
		const handler = createIngestHandler(baseDeps(store, { now: () => 1_234_567_890 }), stats);

		await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-ts')));

		expect(timestamps).toEqual([1_234_567_890]);
	});

	// "Received" (Debug): added 2026-09-13 restoring a capability the
	// maintainer confirmed flows.json had (a log tap ahead of every
	// filter below) that this port had dropped -- see
	// IngestDeps.receivedLog's own doc comment. Unconditional means
	// unconditional: every case here would otherwise leave the message
	// completely untraceable (blacklisted/malformed never reach
	// consumer.ts, and rbe/dedup only ever produce an aggregate counter).
	describe('receivedLog', () => {
		test('fires for an ordinary ingested message, with topic and byte length', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const payload = Buffer.from(wnm('msg-recv-1'));
			const handler = createIngestHandler(baseDeps(store, { receivedLog: logger, sourceLabel: 'GB2' }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);

			expect(debugCalls).toEqual([{ source: 'GB2', topic: 'origin/a/wis2/fr-meteofrance/data/foo', bytes: payload.length, wnmId: 'msg-recv-1', dataId: 'x' }]);
		});

		// 2026-09-20 (NOT a port): the maintainer, after living with this
		// file: "typically the content of wis2gc-received-*.debug.log is
		// useless" -- true before this fix, since {source, topic, bytes}
		// alone can't be grepped for a specific missing data_id (a topic
		// string never contains one). Fixed the same way as filterLog's
		// unchanged/blacklisted outcomes: the extraction only runs when
		// receivedLog.debugEnabled() says debug is the configured level --
		// this call site fires on EVERY message, unconditionally, so it's
		// the hottest path this whole tracing effort touches.
		test('log.level below debug (debugEnabled: false): wnmId/dataId are omitted, no JSON.parse attempted', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const debugCalls: Record<string, unknown>[] = [];
			const handler = createIngestHandler(
				baseDeps(store, { receivedLog: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d), debugEnabled: () => false } }),
				stats,
			);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-recv-nodebug')));

			expect(debugCalls).toEqual([{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', bytes: Buffer.from(wnm('msg-recv-nodebug')).length }]);
		});

		test('log.level: debug (debugEnabled: true): wnmId/dataId are populated', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const debugCalls: Record<string, unknown>[] = [];
			const handler = createIngestHandler(
				baseDeps(store, { receivedLog: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d), debugEnabled: () => true } }),
				stats,
			);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-recv-withdebug')));

			expect(debugCalls[0]).toMatchObject({ wnmId: 'msg-recv-withdebug', dataId: 'x' });
		});

		test('fires for a topic that then gets blacklisted -- this is the only place such a message is individually identifiable', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { receivedLog: logger, blacklist: ['+/+/+/+/+/recommended/#'] }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-recv-2')));

			expect(debugCalls).toHaveLength(1);
			expect(stats.blacklisted).toBe(1);
			expect(store.rawStream).toHaveLength(0); // confirms it really was dropped, yet still logged
		});

		test('fires for malformed JSON', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { receivedLog: logger }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from('{not json'));

			expect(debugCalls).toHaveLength(1);
			expect(stats.malformed).toBe(1);
		});

		test('fires once per call even when rbe/dedup suppress the second one', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { receivedLog: logger }), stats);
			const payload = Buffer.from(wnm('msg-recv-rbe'));

			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);
			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);

			expect(debugCalls).toHaveLength(2); // both arrivals logged, even though the second is dropped by rbe
			expect(stats.unchanged).toBe(1);
		});

		test('fires before the GB2 preDelayMs sleep, not after', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const order: string[] = [];
			const handler = createIngestHandler(
				baseDeps(store, {
					receivedLog: { info: () => {}, warn: () => {}, debug: (d) => { order.push('log'); debugCalls.push(d); } },
					preDelayMs: 2000,
					sleep: async () => void order.push('sleep'),
				}),
				stats,
			);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-recv-order')));

			expect(order).toEqual(['log', 'sleep']);
		});
	});

	// "Filter" (Debug): added 2026-09-20 after the maintainer, chasing
	// still-missing data_id post loop-blocking/hard-cap fixes, asked for a
	// debug build with much heavier logging than the existing debug level
	// provides -- see IngestDeps.filterLog's own doc comment. Unlike
	// receivedLog (which fires once, unconditionally, before any parsing),
	// this fires once per OUTCOME and carries wnm.id/data_id whenever the
	// payload was parseable enough to extract them.
	describe('filterLog', () => {
		test('an "ingested" message logs source/topic/wnmId/dataId/outcome, unconditionally (no isDebugEnabled needed)', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger, sourceLabel: 'GB1' }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-filter-1')));

			expect(debugCalls).toEqual([
				{
					source: 'GB1',
					topic: 'origin/a/wis2/fr-meteofrance/data/foo',
					wnmId: 'msg-filter-1',
					dataId: 'x',
					outcome: 'ingested',
					wnm: JSON.parse(wnm('msg-filter-1')),
				},
			]);
		});

		// 2026-09-20 (same day, NOT a port): the maintainer, right after the
		// receivedLog fix above, pushed back on the whole extraction approach
		// -- "What should be logged is the WNM (probably full content) after
		// deduplication. Not that 'extract'...". This is the direct test for
		// that: the 'ingested' outcome (the one place a message is definitely
		// "after deduplication") must carry the WHOLE parsed object, with
		// fields extractIdsForLogging never touched -- not just wnm.id/
		// properties.data_id.
		test('an "ingested" message carries the FULL wnm, not just its extracted id fields', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger }), stats);
			const fullWnm = { id: 'msg-full-1', links: [{ href: 'https://example.com/a.grib2', rel: 'canonical' }], properties: { pubtime: '2026-01-01T00:00:00Z', data_id: 'data-full-1', integrity: { method: 'sha512', value: 'abc' } } };

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(JSON.stringify(fullWnm)));

			expect(debugCalls[0]!.wnm).toEqual(fullWnm);
		});

		test('a "duplicate" wnm.id logs the SAME wnmId/dataId/wnm that were ingested the first time, unconditionally', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(wnm('msg-filter-dup')));
			await handler('origin/a/wis2/fr-meteofrance/data/bar', Buffer.from(wnm('msg-filter-dup')));

			expect(debugCalls).toEqual([
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', wnmId: 'msg-filter-dup', dataId: 'x', outcome: 'ingested', wnm: JSON.parse(wnm('msg-filter-dup')) },
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/bar', wnmId: 'msg-filter-dup', dataId: 'x', outcome: 'duplicate', wnm: JSON.parse(wnm('msg-filter-dup')) },
			]);
		});

		test('a "malformed" (unparseable) payload logs the parse error, with no wnmId/dataId/wnm to extract', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger }), stats);

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from('{not json'));

			expect(debugCalls).toHaveLength(1);
			expect(debugCalls[0]!.outcome).toBe('malformed');
			expect(debugCalls[0]!.wnmId).toBeUndefined();
			expect(debugCalls[0]!.dataId).toBeUndefined();
			expect(debugCalls[0]!.wnm).toBeUndefined();
			expect(typeof debugCalls[0]!.error).toBe('string');
		});

		test('a "malformed" payload that parses but is missing wnm.id still surfaces its data_id and full content', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger }), stats);
			const orphan = { links: [], properties: { data_id: 'orphan-data-id' } };

			await handler('origin/a/wis2/fr-meteofrance/data/foo', Buffer.from(JSON.stringify(orphan)));

			expect(debugCalls).toHaveLength(1);
			expect(debugCalls[0]).toEqual(expect.objectContaining({ outcome: 'malformed', dataId: 'orphan-data-id', wnmId: undefined, wnm: orphan }));
		});

		// unchanged/blacklisted run BEFORE this handler's own JSON.parse, so
		// logging them means an extra, otherwise-unneeded parse -- gated by
		// filterLog.debugEnabled() (logging/logger.ts), NOT isDebugEnabled()
		// (see IngestDeps.filterLog's doc comment: the maintainer pushed
		// back on needing a separate switch to get the full trace -- "debug
		// in log-level is enough"). fakeReceivedLogger()'s fake doesn't
		// implement debugEnabled() at all, so the `?? true` fallback applies
		// here -- these two tests exercise THAT fallback, with
		// isDebugEnabled() left at its default (false) to prove filterLog
		// doesn't depend on it. See the two tests further below for the
		// real gate (an explicit debugEnabled(): boolean).
		test('an "unchanged" (rbe) drop logs wnmId/dataId when filterLog has no debugEnabled() (assume yes)', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger }), stats); // isDebugEnabled: () => false (baseDeps default)
			const payload = Buffer.from(wnm('msg-filter-unchanged'));

			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);
			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload);

			expect(debugCalls).toEqual([
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', wnmId: 'msg-filter-unchanged', dataId: 'x', outcome: 'ingested', wnm: JSON.parse(wnm('msg-filter-unchanged')) },
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', wnmId: 'msg-filter-unchanged', dataId: 'x', outcome: 'unchanged', wnm: JSON.parse(wnm('msg-filter-unchanged')) },
			]);
		});

		test('a "blacklisted" drop logs wnmId/dataId/wnm when filterLog has no debugEnabled() (assume yes)', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeReceivedLogger();
			const blacklist = ['+/+/+/+/+/recommended/#'];
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger, blacklist }), stats); // isDebugEnabled: () => false (baseDeps default)

			await handler('origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-filter-bl')));

			expect(debugCalls).toEqual([
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/recommended/foo', wnmId: 'msg-filter-bl', dataId: 'x', outcome: 'blacklisted', wnm: JSON.parse(wnm('msg-filter-bl')) },
			]);
		});

		// The real gate: a `filterLog` whose `debugEnabled()` actually
		// reports the configured `global.log.level` (as createSourceLogger's
		// real implementation does -- see logging/logger.ts). This is what
		// makes it safe to run this build everywhere, not just a special
		// debug release: at any level below 'debug', the extra parse for
		// unchanged/blacklisted is skipped entirely, matching what a real
		// deployment sees.
		function fakeLevelGatedLogger(debugEnabled: boolean): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
			const debugCalls: Record<string, unknown>[] = [];
			return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d), debugEnabled: () => debugEnabled }, debugCalls };
		}

		test('log.level below debug (debugEnabled: false): unchanged/blacklisted are skipped entirely -- only outcomes that were parsed anyway still log', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeLevelGatedLogger(false);
			const blacklist = ['+/+/+/+/+/recommended/#'];
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger, blacklist }), stats);
			const payload = Buffer.from(wnm('msg-filter-info-level'));

			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload); // ingested -- already parsed, still logs
			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload); // unchanged -- would need an EXTRA parse, skipped
			await handler('origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-filter-info-level-2'))); // blacklisted -- same, skipped

			expect(debugCalls).toEqual([
				{ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', wnmId: 'msg-filter-info-level', dataId: 'x', outcome: 'ingested', wnm: JSON.parse(wnm('msg-filter-info-level')) },
			]);
		});

		test('log.level: debug (debugEnabled: true): unchanged/blacklisted log normally', async () => {
			const store = new FakeStore();
			const stats = createIngestStats();
			const { logger, debugCalls } = fakeLevelGatedLogger(true);
			const blacklist = ['+/+/+/+/+/recommended/#'];
			const handler = createIngestHandler(baseDeps(store, { filterLog: logger, blacklist }), stats);
			const payload = Buffer.from(wnm('msg-filter-debug-level'));

			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload); // ingested
			await handler('origin/a/wis2/fr-meteofrance/data/foo', payload); // unchanged
			await handler('origin/a/wis2/fr-meteofrance/data/recommended/foo', Buffer.from(wnm('msg-filter-debug-level-2'))); // blacklisted

			expect(debugCalls.map((c) => c.outcome)).toEqual(['ingested', 'unchanged', 'blacklisted']);
			expect(debugCalls[1]).toEqual({ source: 'GB1', topic: 'origin/a/wis2/fr-meteofrance/data/foo', wnmId: 'msg-filter-debug-level', dataId: 'x', outcome: 'unchanged', wnm: JSON.parse(wnm('msg-filter-debug-level')) });
		});
	});
});
