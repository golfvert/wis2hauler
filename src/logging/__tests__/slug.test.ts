import { describe, expect, test } from 'bun:test';
import { slugifySource } from '../slug.ts';

describe('slugifySource', () => {
	test('lowercases and strips everything but a-z', () => {
		expect(slugifySource('Hash')).toBe('hash');
		expect(slugifySource('Correct ?')).toBe('correct');
		expect(slugifySource('Clean Redis')).toBe('cleanredis');
		expect(slugifySource('Process Errors')).toBe('processerrors');
	});

	test('digits and punctuation are dropped, not just punctuation', () => {
		expect(slugifySource('GB1')).toBe('gb');
		expect(slugifySource('Ack (catch)')).toBe('ackcatch');
	});
});
