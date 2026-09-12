import { describe, expect, test } from 'bun:test';
import { runComplete, type CompleteDeps } from '../complete.ts';
import type { HashConfig, HashIO } from '../hash.ts';
import type { SourceLogger } from '../../logging/logger.ts';
import { FakeDownloaderStore } from './fakes.ts';

function fakeSourceLogger(): { logger: SourceLogger; debugCalls: Record<string, unknown>[] } {
	const debugCalls: Record<string, unknown>[] = [];
	return { logger: { info: () => {}, warn: () => {}, debug: (d) => debugCalls.push(d) }, debugCalls };
}

function makeHashIo(overrides: Partial<HashIO> = {}): HashIO {
	return {
		statSize: () => 42,
		dirname: (fp) => fp.split('/').slice(0, -1).join('/'),
		basename: (fp) => fp.split('/').pop() ?? '',
		join: (...parts) => parts.join('/'),
		mkdirRecursive: () => {},
		exists: () => false,
		unlinkSync: () => {},
		renameSync: () => {},
		unlinkAsync: async () => {},
		hashFileBase64: async () => 'expected-digest',
		isUnsupportedHashMethod: () => false,
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
};

function makeDeps(overrides: Partial<CompleteDeps> = {}): { deps: CompleteDeps; store: FakeDownloaderStore } {
	const store = new FakeDownloaderStore();
	const deps: CompleteDeps = {
		store,
		worker: 'downloader1',
		hashConfig,
		hashIo: makeHashIo(),
		newUuid: () => 'fresh-uuid',
		...overrides,
	};
	return { deps, store };
}

const storedWnm = {
	type: 'Feature',
	downloader_id: 'wis2:centre:abc',
	geometry: null,
	properties: { pubtime: '2023-09-08T12:00:00Z', integrity: undefined },
	links: [{ rel: 'canonical', href: 'https://example.com/f.grib2' }],
};

describe('runComplete', () => {
	test('returns null when the downloader_id record has no wnm field', async () => {
		const { deps } = makeDeps();
		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');
		expect(result).toBeNull();
	});

	test('returns null when the wnm field does not parse as JSON', async () => {
		const { deps, store } = makeDeps();
		store.hashes.set('wis2:centre:abc', { wnm: 'not json', topic: 'origin/a/wis2/centre/foo' });
		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');
		expect(result).toBeNull();
	});

	test('HASH_OK: rebuilds the wnm, cleans up gid bookkeeping, and returns the original href', async () => {
		const { deps, store } = makeDeps();
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(storedWnm), topic: 'origin/a/wis2/centre/foo' });
		store.aria2GidRecords.set('downloader1:gid-1', ['x', 'y']);
		store.cancelSchedule.set('downloader1|gid-1', Date.now() + 1000);

		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');

		expect(result).not.toBeNull();
		expect(result?.hashOutcome).toBe('HASH_OK');
		expect(result?.downloaderId).toBe('wis2:centre:abc');
		expect(result?.href).toBe('https://example.com/f.grib2');
		expect(result?.wnmTopic).toBe('origin/a/wis2/centre/foo');
		expect(result?.wnm.id).toBe('fresh-uuid');
		expect(result?.wnm.downloader_id).toBe('wis2:centre:abc');
		expect(result?.wnm.conformsTo).toEqual(['http://wis.wmo.int/spec/wnm/1/conf/core']);
		expect(result?.localHref).toBe('https://downloader.example.com/downloader1/downloads/f.grib2');
		expect(store.deletedAria2GidRecords).toEqual(['downloader1:gid-1']);
		expect(store.deletedAria2GidExpires).toEqual(['downloader1:gid-1']);
		expect(store.cancelSchedule.has('downloader1|gid-1')).toBe(false);
	});

	test('HASH_NOK: a real hash mismatch reports HASH_NOK and the file\'s actual on-disk length (only the exception-routed paths force length 0), and deletes the bad file', async () => {
		const wnmWithIntegrity = { ...storedWnm, properties: { ...storedWnm.properties, integrity: { method: 'sha256', value: 'expected-digest' } } };
		const { deps, store } = makeDeps({ hashIo: makeHashIo({ hashFileBase64: async () => 'wrong-digest' }) });
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(wnmWithIntegrity), topic: 'origin/a/wis2/centre/foo' });

		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');

		expect(result?.hashOutcome).toBe('HASH_NOK');
		expect(result?.length).toBe(42);
	});

	test("a genuine rename-IO failure (RenameIoError) is routed into HASH_NOK per the maintainer's decision, not swallowed or rethrown", async () => {
		const { deps, store } = makeDeps({
			hashConfig: { ...hashConfig, renameToDate: true },
			hashIo: makeHashIo({
				mkdirRecursive: () => {
					throw new Error('EACCES: permission denied');
				},
			}),
		});
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(storedWnm), topic: 'origin/a/wis2/centre/foo' });

		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');

		expect(result?.hashOutcome).toBe('HASH_NOK');
		expect(result?.length).toBe(0);
	});

	test('a genuine hash-read failure (HashReadError) is also routed into HASH_NOK', async () => {
		const wnmWithIntegrity = { ...storedWnm, properties: { ...storedWnm.properties, integrity: { method: 'sha256', value: 'expected-digest' } } };
		const { deps, store } = makeDeps({
			hashIo: makeHashIo({
				hashFileBase64: async () => {
					throw new Error('ENOENT: no such file');
				},
				isUnsupportedHashMethod: () => false,
			}),
		});
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(wnmWithIntegrity), topic: 'origin/a/wis2/centre/foo' });

		const result = await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');

		expect(result?.hashOutcome).toBe('HASH_NOK');
		expect(result?.length).toBe(0);
	});

	test('"Duplicates" (Debug): a routed RenameIoError/HashReadError logs once with the downloaderId and error message', async () => {
		const { logger, debugCalls } = fakeSourceLogger();
		const { deps, store } = makeDeps({
			duplicatesLog: logger,
			hashConfig: { ...hashConfig, renameToDate: true },
			hashIo: makeHashIo({
				mkdirRecursive: () => {
					throw new Error('EACCES: permission denied');
				},
			}),
		});
		store.hashes.set('wis2:centre:abc', { wnm: JSON.stringify(storedWnm), topic: 'origin/a/wis2/centre/foo' });

		await runComplete(deps, 'wis2:centre:abc', 'gid-1', '/downloads/f.grib2');

		expect(debugCalls).toHaveLength(1);
		expect(debugCalls[0]).toMatchObject({ downloaderId: 'wis2:centre:abc', filepath: '/downloads/f.grib2', error: expect.stringContaining('EACCES') });
	});
});
