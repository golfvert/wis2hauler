import { describe, expect, test } from 'bun:test';
import { runFinishing, type FinishingDeps } from '../finishing.ts';
import type { MqttLike } from '../../mqtt/types.ts';
import type { Wnm } from '../../wis2/wnm.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; infoCalls: Record<string, unknown>[]; warnCalls: Record<string, unknown>[] } {
	const infoCalls: Record<string, unknown>[] = [];
	const warnCalls: Record<string, unknown>[] = [];
	return { logger: { info: (d) => infoCalls.push(d), warn: (d) => warnCalls.push(d), debug: () => {} }, infoCalls, warnCalls };
}

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

const wnm: Wnm = {
	id: 'msg-1',
	downloader_id: 'wis2:centre:abc',
	links: [{ rel: 'canonical', href: 'https://example.com/f.grib2' }],
	properties: { pubtime: '2023-09-08T12:00:00Z', data_id: 'abc' },
};

describe('runFinishing', () => {
	test('when completeHref finds no matching href field, nothing downstream runs', async () => {
		const store = new FakeDownloaderStore();
		const { client, published } = makeMqttClient();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client] };

		await runFinishing(deps, 'wis2:centre:abc', wnm, 'origin/a/wis2/centre/foo/bar', 'https://example.com/f.grib2', 'https://local.example.com/f.grib2', '/downloads/f.grib2', 100);

		expect(published).toHaveLength(0);
		expect(store.completeIds.has('wis2:centre:abc')).toBe(false);
		expect(store.cleanerReports).toHaveLength(0);
		expect(store.infoGranules).toHaveLength(0);
	});

	test('a successful transition publishes the cache-swapped wnm, marks complete, reports, and records the info granule', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const { client, published } = makeMqttClient();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client] };

		await runFinishing(
			deps,
			'wis2:centre:abc',
			wnm,
			'origin/a/wis2/centre/foo/deep/path/here',
			'https://example.com/f.grib2',
			'https://local.example.com/f.grib2',
			'/downloads/f.grib2',
			12345,
		);

		expect(published).toHaveLength(1);
		expect(published[0]!.topic).toBe('cache/a/wis2/centre/foo/deep/path/here');
		const cachePayload = JSON.parse(published[0]!.payload);
		expect(cachePayload.links[0].href).toBe('https://local.example.com/f.grib2');
		expect(cachePayload.downloader_id).toBeUndefined();
		expect(cachePayload.properties['global-cache']).toBe('my-centre');
		expect(cachePayload.properties.pubtime).toBe('2023-09-08T12:00:00Z');

		expect(store.completeIds.has('wis2:centre:abc')).toBe(true);

		expect(store.cleanerReports).toHaveLength(1);
		expect(store.cleanerReports[0]!.worker).toBe('downloader1');
		const report = JSON.parse(store.cleanerReports[0]!.report) as string[];
		expect(report[report.length - 2]).toBe('length');
		expect(report[report.length - 1]).toBe('12345');

		expect(store.infoGranules).toEqual([{ uri: '/downloads/f.grib2', length: '12345', centreid: 'centre', topic: 'path/here' }]);
	});

	test('passes localPath through to the store as the "local-path" hash field (2026-09-13: feeds cleaner/schedule.ts, see lua.ts LUA_COMPLETE)', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const { client } = makeMqttClient();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client] };

		await runFinishing(
			deps,
			'wis2:centre:abc',
			wnm,
			'origin/a/wis2/centre/foo/bar',
			'https://example.com/f.grib2',
			'https://local.example.com/f.grib2',
			'/downloads/f.grib2',
			1,
			'centre/foo/f.grib2',
		);

		expect(store.hashes.get('wis2:centre:abc')?.['local-path']).toBe('centre/foo/f.grib2');
	});

	test('an omitted localPath (S3 mode, or no Hash step at all) records an empty "local-path" field rather than leaving it unset', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const { client } = makeMqttClient();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client] };

		await runFinishing(deps, 'wis2:centre:abc', wnm, 'origin/a/wis2/centre/foo/bar', 'https://example.com/f.grib2', 'https://local.example.com/f.grib2', '/downloads/f.grib2', 1);

		expect(store.hashes.get('wis2:centre:abc')?.['local-path']).toBe('');
	});

	test('publishes to every configured client, in order', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const pub1 = makeMqttClient();
		const pub2 = makeMqttClient();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [pub1.client, pub2.client] };

		await runFinishing(deps, 'wis2:centre:abc', wnm, 'origin/a/wis2/centre/foo/bar', 'https://example.com/f.grib2', 'https://local.example.com/f.grib2', '/downloads/f.grib2', 1);

		expect(pub1.published).toHaveLength(1);
		expect(pub2.published).toHaveLength(1);
	});

	test('"Link" (Info): a successful transition logs once with the local href', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const { client } = makeMqttClient();
		const { logger, infoCalls, warnCalls } = fakeSourceLogger();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client], linkLog: logger };

		await runFinishing(deps, 'wis2:centre:abc', wnm, 'origin/a/wis2/centre/foo/bar', 'https://example.com/f.grib2', 'https://local.example.com/f.grib2', '/downloads/f.grib2', 1);

		expect(infoCalls).toEqual([{ downloaderId: 'wis2:centre:abc', link: 'https://local.example.com/f.grib2' }]);
		expect(warnCalls).toHaveLength(0);
	});

	test('"Link" (Warn): a wnm with no links at all logs the anomaly instead of the Info', async () => {
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const { client } = makeMqttClient();
		const { logger, infoCalls, warnCalls } = fakeSourceLogger();
		const deps: FinishingDeps = { store, worker: 'downloader1', centreId: 'my-centre', publishClients: [client], linkLog: logger };
		const noLinkWnm: Wnm = { ...wnm, links: [] };

		await runFinishing(deps, 'wis2:centre:abc', noLinkWnm, 'origin/a/wis2/centre/foo/bar', 'https://example.com/f.grib2', 'https://local.example.com/f.grib2', '/downloads/f.grib2', 1);

		expect(warnCalls).toEqual([{ downloaderId: 'wis2:centre:abc', wnmTopic: 'origin/a/wis2/centre/foo/bar', href: 'https://example.com/f.grib2' }]);
		// The Info still fires afterward -- it isn't gated on firstLink being present.
		expect(infoCalls).toHaveLength(1);
	});

	test('a rejecting publish (e.g. a disconnected local-broker client) is reported with explicit "local-broker publish failed" context, but does NOT abort the other 3 independent steps', async () => {
		// Regression test for the 2026-09-11 bug: an earlier version of
		// runFinishing let this rejection propagate and abort the whole
		// function, silently skipping markDownloadComplete/
		// publishCleanerReport/recordInfoGranule too -- which is what
		// left Reporter's metrics completely empty even though real
		// downloads were completing successfully, any time the local
		// broker happened to be down or still reconnecting.
		const store = new FakeDownloaderStore();
		store.hashes.set('wis2:centre:abc', { 'https://example.com/f.grib2': 'queue' });
		const client: MqttLike = {
			subscribe: async () => {},
			onMessage: () => {},
			publish: async () => {
				throw new Error('mqtt client not connected (cannot publish to cache/a/wis2/centre/foo/bar)');
			},
			end: async () => {},
		};
		const errors: string[] = [];
		const deps: FinishingDeps = {
			store,
			worker: 'downloader1',
			centreId: 'my-centre',
			publishClients: [client],
			error: (m) => errors.push(m),
		};

		// Must resolve, not reject -- a down local broker is a partial,
		// logged failure, never a fatal one.
		await runFinishing(
			deps,
			'wis2:centre:abc',
			wnm,
			'origin/a/wis2/centre/foo/bar',
			'https://example.com/f.grib2',
			'https://local.example.com/f.grib2',
			'/downloads/f.grib2',
			1,
		);

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('step 1/4 cache republish failed');
		expect(errors[0]).toContain(
			'local-broker publish failed (cache-topic republish, topic cache/a/wis2/centre/foo/bar): mqtt client not connected (cannot publish to cache/a/wis2/centre/foo/bar)',
		);

		// The other 3 independent steps must still have run.
		expect(store.completeIds.has('wis2:centre:abc')).toBe(true);
		expect(store.cleanerReports).toHaveLength(1);
		expect(store.cleanerReports[0]!.worker).toBe('downloader1');
		expect(store.infoGranules).toEqual([{ uri: '/downloads/f.grib2', length: '1', centreid: 'centre', topic: '' }]);
	});
});
