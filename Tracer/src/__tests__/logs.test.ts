import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseLogFilename, parseFilenameBucketMs, valueContains, walkLogFiles, matchesInFile } from '../logs.ts';

describe('parseLogFilename', () => {
	test('parses a plain .log file', () => {
		expect(parseLogFilename('wis2gc-filter-2026-09-20-16.debug.log')).toEqual({
			slug: 'filter',
			dateHour: '2026-09-20-16',
			level: 'debug',
			rotation: undefined,
			gzip: false,
		});
	});

	test('parses a rotated, gzip-archived file', () => {
		expect(parseLogFilename('wis2gc-received-2026-09-20-08.debug.log.gz')).toEqual({
			slug: 'received',
			dateHour: '2026-09-20-08',
			level: 'debug',
			rotation: undefined,
			gzip: true,
		});
	});

	// A busy logger (Filter, carrying the full WNM per message) can blow
	// past winston-daily-rotate-file's maxSize more than once inside the
	// SAME hour, producing "...log.1.gz", "...log.2.gz", etc. alongside
	// the hour's first "...log.gz" chunk -- found live in production
	// 2026-09-21 (Filter routinely had 2-3 such chunks/hour on a busy
	// feed) and, before this test existed, silently invisible to every
	// trace: parseLogFilename returned undefined for them, so
	// walkLogFiles skipped them with no warning at all.
	test('parses a same-hour rotation chunk ("...log.N.gz", maxSize-triggered)', () => {
		expect(parseLogFilename('wis2gc-filter-2026-09-21-03.debug.log.1.gz')).toEqual({
			slug: 'filter',
			dateHour: '2026-09-21-03',
			level: 'debug',
			rotation: 1,
			gzip: true,
		});
		expect(parseLogFilename('wis2gc-filter-2026-09-21-10.debug.log.2.gz')).toEqual({
			slug: 'filter',
			dateHour: '2026-09-21-10',
			level: 'debug',
			rotation: 2,
			gzip: true,
		});
	});

	test('rejects a filename that is not one of Hauler\'s own log files', () => {
		expect(parseLogFilename('not-a-wis2gc-file.log')).toBeUndefined();
		expect(parseLogFilename('wis2gc-filter-2026-09-20-16.info.log.tar.gz')).toBeUndefined();
		expect(parseLogFilename('wis2gc-Filter-2026-09-20-16.debug.log')).toBeUndefined(); // slug must already be lowercased
	});
});

describe('parseFilenameBucketMs', () => {
	test('treats the bucket as the start of that UTC hour', () => {
		expect(parseFilenameBucketMs('2026-09-20-16')).toBe(Date.parse('2026-09-20T16:00:00Z'));
	});
});

describe('valueContains', () => {
	test('finds a substring on a top-level string field', () => {
		expect(valueContains({ dataId: 'wis2/foo/bar-123' }, 'foo/bar')).toBe(true);
		expect(valueContains({ dataId: 'wis2/foo/bar-123' }, 'nope')).toBe(false);
	});

	test('finds a substring nested inside an object (e.g. the full wnm Filter now attaches)', () => {
		const line = { source: 'GB1', outcome: 'ingested', wnm: { id: 'msg-1', properties: { data_id: 'the-data-id' } } };
		expect(valueContains(line, 'the-data-id')).toBe(true);
		expect(valueContains(line, 'msg-1')).toBe(true);
	});

	test('finds a substring nested inside an array (e.g. wnm.links)', () => {
		const line = { wnm: { links: [{ href: 'https://example.com/target-file.grib2', rel: 'canonical' }] } };
		expect(valueContains(line, 'target-file')).toBe(true);
	});

	test('non-string, non-object leaves (numbers, booleans, null) never match', () => {
		expect(valueContains({ bytes: 999, ok: true, missing: null }, '999')).toBe(false);
	});
});

describe('walkLogFiles + matchesInFile (integration, real filesystem)', () => {
	async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
		const dir = await mkdtemp(join(tmpdir(), 'wis2hauler-tracer-test-'));
		try {
			await fn(dir);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}

	test('finds a matching line in a plain .log file nested under a worker/logs/ directory', async () => {
		await withTempDir(async (dir) => {
			const logsDir = join(dir, 'one', 'logs');
			await mkdir(logsDir, { recursive: true });
			const lines = [
				JSON.stringify({ source: 'GB2', topic: 'a', bytes: 10, timestamp: '2026-09-20T16:00:00.000Z' }),
				JSON.stringify({ source: 'GB2', topic: 'b', wnmId: 'target-wnm-id', dataId: 'target-data-id', timestamp: '2026-09-20T16:00:01.000Z' }),
			];
			await writeFile(join(logsDir, 'wis2gc-received-2026-09-20-16.debug.log'), lines.join('\n') + '\n');

			const files: string[] = [];
			for await (const f of walkLogFiles(dir)) files.push(f);
			expect(files).toHaveLength(1);

			const parsed = parseLogFilename('wis2gc-received-2026-09-20-16.debug.log');
			expect(parsed).toBeDefined();
			const matches = [];
			for await (const m of matchesInFile(files[0] as string, parsed!, 'target-wnm-id')) matches.push(m);

			expect(matches).toHaveLength(1);
			expect(matches[0]!.data.wnmId).toBe('target-wnm-id');
			expect(matches[0]!.timestamp).toBe('2026-09-20T16:00:01.000Z');
			expect(matches[0]!.source).toBe('received');
			expect(matches[0]!.level).toBe('debug');
		});
	});

	test('reads a gzip-rotated log file transparently', async () => {
		await withTempDir(async (dir) => {
			await mkdir(dir, { recursive: true });
			const line = JSON.stringify({ dataId: 'gz-target', outcome: 'ingested', timestamp: '2026-09-20T10:00:00.000Z' });
			const gz = gzipSync(Buffer.from(line + '\n'));
			await writeFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log.gz'), gz);

			const files: string[] = [];
			for await (const f of walkLogFiles(dir)) files.push(f);
			expect(files).toHaveLength(1);

			const parsed = parseLogFilename('wis2gc-filter-2026-09-20-10.debug.log.gz')!;
			const matches = [];
			for await (const m of matchesInFile(files[0] as string, parsed, 'gz-target')) matches.push(m);
			expect(matches).toHaveLength(1);
			expect(matches[0]!.data.outcome).toBe('ingested');
		});
	});

	test('picks up a same-hour rotation chunk ("...log.1.gz") alongside the hour\'s first chunk', async () => {
		await withTempDir(async (dir) => {
			const first = gzipSync(Buffer.from(JSON.stringify({ dataId: 'rotated-id', chunk: 0, timestamp: '2026-09-21T03:10:00.000Z' }) + '\n'));
			const rotated = gzipSync(Buffer.from(JSON.stringify({ dataId: 'rotated-id', chunk: 1, timestamp: '2026-09-21T03:40:00.000Z' }) + '\n'));
			await writeFile(join(dir, 'wis2gc-filter-2026-09-21-03.debug.log.gz'), first);
			await writeFile(join(dir, 'wis2gc-filter-2026-09-21-03.debug.log.1.gz'), rotated);

			const files: string[] = [];
			for await (const f of walkLogFiles(dir)) files.push(f);
			expect(files).toHaveLength(2); // both chunks found, not just the first

			const matches = [];
			for (const file of files) {
				const parsed = parseLogFilename(file.split('/').pop()!)!;
				for await (const m of matchesInFile(file, parsed, 'rotated-id')) matches.push(m);
			}
			expect(matches).toHaveLength(2);
			expect(matches.map((m) => m.data.chunk).sort()).toEqual([0, 1]);
		});
	});

	test('ignores files that are not shaped like wis2gc log files', async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, 'notes.txt'), 'target-data-id appears here too, but this is not a log file');
			await writeFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log.bak'), JSON.stringify({ dataId: 'target-data-id' }));

			const files: string[] = [];
			for await (const f of walkLogFiles(dir)) files.push(f);
			expect(files).toHaveLength(0);
		});
	});

	test('--since/--until bound matches by the LINE\'s own timestamp, not the file bucket', async () => {
		await withTempDir(async (dir) => {
			const lines = [
				JSON.stringify({ dataId: 'windowed-id', outcome: 'a', timestamp: '2026-09-20T09:00:00.000Z' }), // before window
				JSON.stringify({ dataId: 'windowed-id', outcome: 'b', timestamp: '2026-09-20T10:30:00.000Z' }), // inside window
				JSON.stringify({ dataId: 'windowed-id', outcome: 'c', timestamp: '2026-09-20T12:00:00.000Z' }), // after window
			];
			await writeFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log'), lines.join('\n') + '\n');

			const parsed = parseLogFilename('wis2gc-filter-2026-09-20-10.debug.log')!;
			const sinceMs = Date.parse('2026-09-20T10:00:00Z');
			const untilMs = Date.parse('2026-09-20T11:00:00Z');
			const matches = [];
			for await (const m of matchesInFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log'), parsed, 'windowed-id', sinceMs, untilMs)) matches.push(m);

			expect(matches).toHaveLength(1);
			expect(matches[0]!.data.outcome).toBe('b');
		});
	});

	test('a malformed (non-JSON) line still matches via raw substring fallback, with no timestamp', async () => {
		await withTempDir(async (dir) => {
			await writeFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log'), 'this line contains raw-fallback-id but is not JSON\n');
			const parsed = parseLogFilename('wis2gc-filter-2026-09-20-10.debug.log')!;
			const matches = [];
			for await (const m of matchesInFile(join(dir, 'wis2gc-filter-2026-09-20-10.debug.log'), parsed, 'raw-fallback-id')) matches.push(m);
			expect(matches).toHaveLength(1);
			expect(matches[0]!.timestamp).toBeUndefined();
			expect(typeof matches[0]!.data.raw).toBe('string');
		});
	});
});
