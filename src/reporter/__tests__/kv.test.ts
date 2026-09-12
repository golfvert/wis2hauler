import { describe, expect, test } from 'bun:test';
import { transformKV } from '../kv.ts';

describe('transformKV', () => {
	test('a normal completion record derives length/delay/centreId/subtopic/lastTimestamp', () => {
		const published = new Date('2026-09-10T00:00:00.000Z').toISOString();
		const stored = String(new Date('2026-09-10T00:00:05.000Z').getTime());
		const flat = ['length', '12345', 'stored', stored, 'published', published, 'topic', 'origin/a/wis2/centre-1/data/core/weather/x/y'];
		const record = transformKV(flat);
		expect(record.length).toBe(12345);
		expect(record.centreId).toBe('centre-1');
		expect(record.subtopic).toBe('core/weather/x');
		expect(record.delay).toBe(Number(stored) - new Date(published).getTime());
		expect(record.lastTimestamp).toBe(Math.floor(Number(stored) / 1000));
	});

	test('length defaults to 0 when the field is missing', () => {
		const record = transformKV(['topic', 'a/b/c/d']);
		expect(record.length).toBe(0);
	});

	test('delay and lastTimestamp are null when stored/published are missing', () => {
		const record = transformKV(['length', '10']);
		expect(record.delay).toBeNull();
		expect(record.lastTimestamp).toBeNull();
	});

	test('centreId/subtopic are null when topic is missing or too short', () => {
		expect(transformKV([]).centreId).toBeNull();
		expect(transformKV(['topic', 'a/b']).centreId).toBeNull();
		expect(transformKV(['topic', 'a/b/c/centre-x']).subtopic).toBeNull();
	});

	test('source is read from the "src:<field>" sibling of whichever field value starts with "complete"', () => {
		const record = transformKV(['href', 'complete', 'src:href', 'origin-worker-1']);
		expect(record.source).toBe('origin-worker-1');
	});

	test('source is null when no field value starts with "complete"', () => {
		expect(transformKV(['href', 'queue']).source).toBeNull();
	});

	test('source is null when the matching sibling "src:<field>" is itself missing/falsy', () => {
		expect(transformKV(['href', 'complete']).source).toBeNull();
	});

	test('an integrity_fail/download_error record (type+topic only) round-trips through raw', () => {
		const record = transformKV(['type', 'integrity_fail', 'topic', 'origin/a/wis2/centre-1/data']);
		expect(record.raw.type).toBe('integrity_fail');
		expect(record.raw.topic).toBe('origin/a/wis2/centre-1/data');
	});
});
