import { describe, expect, test } from 'bun:test';
import { buildBytesOp, buildFilesOp, buildIpsOp, deriveCountry, extractGranuleRecord, parseCaddyLogEntry } from '../caddy.ts';

describe('parseCaddyLogEntry', () => {
	test('extracts client_ip and uri from the first log entry', () => {
		expect(parseCaddyLogEntry([{ client_ip: '1.2.3.4', uri: '/foo/bar' }])).toEqual({ clientIp: '1.2.3.4', uri: '/foo/bar' });
	});
	test('rejects a non-array, empty array, or malformed first entry instead of throwing', () => {
		expect(parseCaddyLogEntry(null)).toBeNull();
		expect(parseCaddyLogEntry([])).toBeNull();
		expect(parseCaddyLogEntry([{ client_ip: '1.2.3.4' }])).toBeNull();
		expect(parseCaddyLogEntry('not-an-array')).toBeNull();
	});
});

describe('deriveCountry', () => {
	test('returns the geo lookup country when found', () => {
		expect(deriveCountry({ country: 'US' })).toBe('US');
	});
	test('returns "zz" when the lookup found nothing', () => {
		expect(deriveCountry(null)).toBe('zz');
	});
});

describe('extractGranuleRecord', () => {
	test('flattens the HGETALL reply and picks length/centreid/topic', () => {
		const record = extractGranuleRecord(['length', '500', 'centreid', 'centre-1', 'topic', 'core/weather', 'other', 'ignored']);
		expect(record).toEqual({ length: '500', centreid: 'centre-1', topic: 'core/weather' });
	});
	test('missing fields come back undefined', () => {
		expect(extractGranuleRecord([])).toEqual({ length: undefined, centreid: undefined, topic: undefined });
	});
});

describe('metric op builders', () => {
	const granule = { length: '1024', centreid: 'centre-1', topic: 'core/weather' };

	test('buildFilesOp increments by 1 with the full label set', () => {
		expect(buildFilesOp(granule, 'US', 'my-centre')).toEqual({
			op: 'inc',
			labels: { centre_id: 'centre-1', topic: 'core/weather', user_country: 'US', report_by: 'my-centre' },
			val: 1,
		});
	});

	test('buildBytesOp increments by Number(length)', () => {
		expect(buildBytesOp(granule, 'US', 'my-centre').val).toBe(1024);
	});

	test('buildBytesOp yields NaN (not 0) for a missing/non-numeric length -- matches $number() on an unparseable value, not silently defaulted', () => {
		const noLength = { length: undefined, centreid: 'centre-1', topic: 'core/weather' };
		expect(Number.isNaN(buildBytesOp(noLength, 'US', 'my-centre').val)).toBe(true);
	});

	test('buildIpsOp sets the given distinct count', () => {
		expect(buildIpsOp(granule, 'US', 'my-centre', 7)).toEqual({
			op: 'set',
			labels: { centre_id: 'centre-1', topic: 'core/weather', user_country: 'US', report_by: 'my-centre' },
			val: 7,
		});
	});
});
