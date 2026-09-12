import { describe, expect, test } from 'bun:test';
import { computeDownloaderId } from '../content-id.ts';
import type { Wnm } from '../../wis2/wnm.ts';

describe('computeDownloaderId', () => {
	test('uses the first 12 chars of the integrity value with slashes removed, when present', () => {
		const wnm: Wnm = {
			id: 'm',
			links: [],
			properties: { pubtime: '2026-09-09T00:00:00Z', data_id: 'urn:x:1', integrity: { value: 'ab/cd/ef01234567890/zz' } },
		};
		expect(computeDownloaderId(wnm)).toBe('urn:x:1:2026-09-09T00:00:00Z:abcdef012345');
	});

	test('falls back to the digits of pubtime when there is no integrity value', () => {
		const wnm: Wnm = { id: 'm', links: [], properties: { pubtime: '2026-09-09T12:34:56Z', data_id: 'urn:x:1' } };
		expect(computeDownloaderId(wnm)).toBe('urn:x:1:2026-09-09T12:34:56Z:20260909123456');
	});
});
