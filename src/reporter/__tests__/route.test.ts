import { describe, expect, test } from 'bun:test';
import { classifyReportType } from '../route.ts';

describe('classifyReportType', () => {
	test('integrity_fail and download_error classify by exact match', () => {
		expect(classifyReportType('integrity_fail')).toBe('integrity_fail');
		expect(classifyReportType('download_error')).toBe('download_error');
	});
	test('anything else (including undefined) falls through to stats', () => {
		expect(classifyReportType(undefined)).toBe('stats');
		expect(classifyReportType('something-else')).toBe('stats');
		expect(classifyReportType(null)).toBe('stats');
	});
});
