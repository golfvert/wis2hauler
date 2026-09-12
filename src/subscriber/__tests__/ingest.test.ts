import { describe, expect, test } from 'bun:test';
import { createIngestHandler, createIngestStats, type IngestDeps } from '../ingest.ts';
import { FakeStore } from './fakes.ts';

function fakeLog() {
	const lines: string[] = [];
	return { log: { log: (...a: unknown[]) => lines.push(a.join(' ')), error: (...a: unknown[]) => lines.push(a.join(' ')), warn: () => {} } as unknown as typeof console, lines };
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
});
