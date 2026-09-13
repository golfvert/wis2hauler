import { describe, expect, test } from 'bun:test';
import { decideSchedule, type ScheduleConfig } from '../schedule.ts';

const baseConfig: ScheduleConfig = { keepInCacheSeconds: 3600 };

// REWRITTEN, 2026-09-13 (the maintainer, "option 1, with the caveat for
// S3, and it must work for docker and bare metal"): decideSchedule() no
// longer pattern-matches a "downloads/" literal out of the published
// "link" URL at all -- see schedule.ts's header comment for the full
// history (the original's own hardcoded literal, ported faithfully
// earlier today, turned out to still be wrong for this port specifically,
// since bare-metal deployments aren't guaranteed to name every worker's
// download directory "downloads"). It now reads the "local-path" field
// each DOWNLOADER worker publishes itself (relative to ITS OWN
// aria-download, computed in hash.ts) directly off the flat
// cleaner-reporter record, with no marker/substring matching left at all.
describe('decideSchedule', () => {
	test('S3-mode downloads (hash.ts never sets local-path) are skipped, regardless of "link"', () => {
		const result = decideSchedule(baseConfig, ['link', 'https://cdn.example.com/foo/bar.grib2', 'local-path', ''], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('a record with no local-path field at all is skipped (download_error/integrity_fail, or a not-yet-upgraded worker)', () => {
		const result = decideSchedule(baseConfig, ['type', 'download_error', 'topic', 'a/wis2/x'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('keep-in-cache unset (undefined) skips -- file kept forever', () => {
		const result = decideSchedule({ keepInCacheSeconds: undefined }, ['local-path', 'foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('keep-in-cache <= 0 also skips -- the pre-existing quirk (kept, not fixed): file is never scheduled, despite validate.ts warning it will be "deleted immediately"', () => {
		const result = decideSchedule({ keepInCacheSeconds: 0 }, ['local-path', 'foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
		const resultNeg = decideSchedule({ keepInCacheSeconds: -5 }, ['local-path', 'foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(resultNeg).toBeNull();
	});

	test('a valid local-file record schedules a ZADD at now + keep*1000, keyed "<worker>|<local-path>" -- Docker-style path (aria-download "/downloads") still works', () => {
		const result = decideSchedule(baseConfig, ['link', 'http://host/downloads/2026/09/10/data.grib2', 'local-path', '2026/09/10/data.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000000);
		expect(result).toEqual({ scoreMs: String(1000000 + 3600 * 1000), member: 'worker-1|2026/09/10/data.grib2' });
	});

	test('a bare-metal aria-download with no "downloads" in its name at all now works too -- the whole point of the fix', () => {
		// e.g. downloader['aria-download'] === "/home/xyz/files/something" on
		// bare metal -- the old "downloads/" literal would never match this,
		// silently and permanently leaking disk. local-path carries the file's
		// path relative to THAT worker's own aria-download directly, so this
		// is no different from any other record.
		const result = decideSchedule(baseConfig, ['link', 'http://host/worker-1/home/xyz/files/something/2026/09/10/data.grib2', 'local-path', '2026/09/10/data.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000000);
		expect(result).toEqual({ scoreMs: String(1000000 + 3600 * 1000), member: 'worker-1|2026/09/10/data.grib2' });
	});

	test('the worker name is extracted from the pubsub channel, after the "cleaner-reporter:" prefix', () => {
		const result = decideSchedule(baseConfig, ['local-path', 'x.bin'], 'wis2gc:cleaner-reporter:my-worker-42', 0);
		expect(result?.member).toBe('my-worker-42|x.bin');
	});

	test('a config with no downloader section at all (a CLEANER-only deployment, e.g. fixtures/example.cleaner-only.yaml, or worker "one" in a real multi-worker Global Cache) still correctly schedules a link published by some OTHER worker\'s DOWNLOADER role', () => {
		const cleanerOnlyConfig: ScheduleConfig = { keepInCacheSeconds: 3600 };
		const result = decideSchedule(cleanerOnlyConfig, ['local-path', '2026/09/10/data.grib2'], 'wis2gc:cleaner-reporter:some-other-worker', 1000000);
		expect(result).toEqual({ scoreMs: String(1000000 + 3600 * 1000), member: 'some-other-worker|2026/09/10/data.grib2' });
	});
});
