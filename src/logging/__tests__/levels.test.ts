import { describe, expect, test } from 'bun:test';
import { levelAdmits } from '../levels.ts';

describe('levelAdmits', () => {
	test('configured "info" admits only info-tagged messages', () => {
		expect(levelAdmits('info', 'info')).toBe(true);
		expect(levelAdmits('info', 'warn')).toBe(false);
		expect(levelAdmits('info', 'debug')).toBe(false);
	});

	test('configured "warn" admits info and warn, not debug', () => {
		expect(levelAdmits('warn', 'info')).toBe(true);
		expect(levelAdmits('warn', 'warn')).toBe(true);
		expect(levelAdmits('warn', 'debug')).toBe(false);
	});

	test('configured "debug" admits everything', () => {
		expect(levelAdmits('debug', 'info')).toBe(true);
		expect(levelAdmits('debug', 'warn')).toBe(true);
		expect(levelAdmits('debug', 'debug')).toBe(true);
	});
});
