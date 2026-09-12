import { describe, expect, test } from 'bun:test';
import { buildHashOrErrorOp } from '../hash-error.ts';

describe('buildHashOrErrorOp', () => {
	test('extracts centre_id from the 4th "/"-separated segment of topic (payload.topic, the fix for the wnmtopic bug)', () => {
		const op = buildHashOrErrorOp('origin/a/wis2/centre-1/data/core/weather', 'my-centre');
		expect(op).toEqual({ op: 'inc', labels: { centre_id: 'centre-1', report_by: 'my-centre' }, val: 1 });
	});

	test('an undefined topic yields an empty centre_id rather than throwing', () => {
		const op = buildHashOrErrorOp(undefined, 'my-centre');
		expect(op.labels.centre_id).toBe('');
	});

	test('a topic with fewer than 4 segments yields an empty centre_id', () => {
		const op = buildHashOrErrorOp('a/b', 'my-centre');
		expect(op.labels.centre_id).toBe('');
	});
});
