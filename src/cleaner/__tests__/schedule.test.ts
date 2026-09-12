import { describe, expect, test } from 'bun:test';
import { decideSchedule, computeDownloadsMarker, type ScheduleConfig } from '../schedule.ts';

const baseConfig: ScheduleConfig = { renameToS3: false, keepInCacheSeconds: 3600, downloadsMarker: 'downloads/' };

describe('decideSchedule', () => {
	test('S3 mode always skips, regardless of payload', () => {
		const result = decideSchedule({ renameToS3: true, keepInCacheSeconds: 3600, downloadsMarker: 'downloads/' }, ['link', 'downloads/foo/bar.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('a record with no link (download_error/integrity_fail) is skipped', () => {
		const result = decideSchedule(baseConfig, ['type', 'download_error', 'topic', 'a/wis2/x'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('a link that does not contain "downloads/" is skipped', () => {
		const result = decideSchedule(baseConfig, ['link', 'http://example.com/foo'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('keep-in-cache unset (undefined) skips -- file kept forever', () => {
		const result = decideSchedule({ renameToS3: false, keepInCacheSeconds: undefined, downloadsMarker: 'downloads/' }, ['link', 'downloads/foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
	});

	test('keep-in-cache <= 0 also skips -- the pre-existing quirk (kept, not fixed): file is never scheduled, despite validate.ts warning it will be "deleted immediately"', () => {
		const result = decideSchedule({ renameToS3: false, keepInCacheSeconds: 0, downloadsMarker: 'downloads/' }, ['link', 'downloads/foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(result).toBeNull();
		const resultNeg = decideSchedule({ renameToS3: false, keepInCacheSeconds: -5, downloadsMarker: 'downloads/' }, ['link', 'downloads/foo.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000);
		expect(resultNeg).toBeNull();
	});

	test('a valid local-file record schedules a ZADD at now + keep*1000, keyed "<worker>|<path-under-downloads/>"', () => {
		const result = decideSchedule(baseConfig, ['link', 'http://host/downloads/2026/09/10/data.grib2'], 'wis2gc:cleaner-reporter:worker-1', 1000000);
		expect(result).toEqual({ scoreMs: String(1000000 + 3600 * 1000), member: 'worker-1|2026/09/10/data.grib2' });
	});

	test('the worker name is extracted from the pubsub channel, after the "cleaner-reporter:" prefix', () => {
		const result = decideSchedule(baseConfig, ['link', 'downloads/x.bin'], 'wis2gc:cleaner-reporter:my-worker-42', 0);
		expect(result?.member).toBe('my-worker-42|x.bin');
	});

	test('downloadsMarker undefined (aria-download not configured) skips every record, rather than guessing a marker', () => {
		const result = decideSchedule(
			{ renameToS3: false, keepInCacheSeconds: 3600, downloadsMarker: undefined },
			['link', 'http://host/downloads/2026/09/10/data.grib2'],
			'wis2gc:cleaner-reporter:worker-1',
			1000,
		);
		expect(result).toBeNull();
	});
});

describe('computeDownloadsMarker', () => {
	test('derives the marker from the directory\'s own last path segment, plus a trailing slash', () => {
		expect(computeDownloadsMarker('/Users/remy/Docker/WIS2/Aria2/Downloads')).toBe('Downloads/');
		expect(computeDownloadsMarker('/downloads')).toBe('downloads/');
		expect(computeDownloadsMarker('/downloads/')).toBe('downloads/'); // trailing slash on the input doesn't change the basename
	});

	test('undefined input (aria-download not configured) yields undefined, not a guessed default', () => {
		expect(computeDownloadsMarker(undefined)).toBeUndefined();
	});
});
