import { describe, expect, test } from 'bun:test';
import { selectLink, firstOf, linkLength, type Wnm } from '../wnm.ts';

const baseWnm = (links: Wnm['links']): Wnm => ({
	id: 'msg-1',
	links,
	properties: { pubtime: '2026-09-09T00:00:00Z', data_id: 'urn:x:1' },
});

describe('selectLink', () => {
	test('prefers update over canonical', () => {
		const wnm = baseWnm([
			{ rel: 'canonical', href: 'https://a/canonical' },
			{ rel: 'update', href: 'https://a/update' },
		]);
		expect(selectLink(wnm)?.href).toBe('https://a/update');
	});
	test('falls back to canonical when there is no update link', () => {
		const wnm = baseWnm([{ rel: 'canonical', href: 'https://a/canonical' }]);
		expect(selectLink(wnm)?.href).toBe('https://a/canonical');
	});
	test('undefined when neither is present', () => {
		const wnm = baseWnm([{ rel: 'deletion', href: 'https://a/deleted' }]);
		expect(selectLink(wnm)).toBeUndefined();
	});
});

describe('firstOf', () => {
	test('passes through a plain string', () => expect(firstOf('x')).toBe('x'));
	test('takes the first element of an array', () => expect(firstOf(['x', 'y'])).toBe('x'));
	test('undefined stays undefined', () => expect(firstOf(undefined)).toBeUndefined());
});

describe('linkLength', () => {
	test('reads the selected link\'s length', () => {
		const wnm = baseWnm([{ rel: 'canonical', href: 'https://a', length: 42 }]);
		expect(linkLength(wnm)).toBe(42);
	});
	test('falls back to 99999 when absent, matching the original', () => {
		const wnm = baseWnm([{ rel: 'canonical', href: 'https://a' }]);
		expect(linkLength(wnm)).toBe(99999);
	});
});
