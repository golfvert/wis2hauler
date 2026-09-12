import { describe, expect, test } from 'bun:test';
import { resolveSinkOptions, createLogSinkFromConfig } from '../from-config.ts';
import { WinstonLogSink } from '../sink.ts';
import type { LogConfig } from '../../config/schema.ts';

describe('resolveSinkOptions', () => {
	test('to: "file" plus size/number/dir all pass straight through', () => {
		const log: LogConfig = { level: 'info', to: 'file', size: 50, number: 10, dir: '/custom-logs' };
		expect(resolveSinkOptions(log)).toEqual({
			destination: 'file',
			logDir: '/custom-logs',
			maxSize: 50,
			maxFiles: 10,
		});
	});

	test('to: "stdout" maps to the stdout destination', () => {
		const log: LogConfig = { level: 'debug', to: 'stdout' };
		expect(resolveSinkOptions(log).destination).toBe('stdout');
	});

	test('an unset `to` defaults to stdout, same as validate.ts\'s own reporting', () => {
		const log: LogConfig = { level: 'warn' };
		expect(resolveSinkOptions(log).destination).toBe('stdout');
	});

	test('unset size/number/dir pass through as undefined -- WinstonLogSink applies its own defaults', () => {
		const log: LogConfig = { level: 'info' };
		const options = resolveSinkOptions(log);
		expect(options.logDir).toBeUndefined();
		expect(options.maxSize).toBeUndefined();
		expect(options.maxFiles).toBeUndefined();
	});

	test('any `to` other than the literal "file" is treated as stdout, matching the strict either/or', () => {
		// Not reachable through the real schema (to is a 'stdout' | 'file' union),
		// but resolveSinkOptions itself should still fail safe toward stdout
		// rather than silently opening a file logger for a bogus value.
		const log = { level: 'info', to: 'bogus' } as unknown as LogConfig;
		expect(resolveSinkOptions(log).destination).toBe('stdout');
	});
});

describe('createLogSinkFromConfig', () => {
	test('builds a real WinstonLogSink for a file-destination config', () => {
		const sink = createLogSinkFromConfig({ level: 'info', to: 'file', size: 10, number: 2, dir: '/tmp/does-not-need-to-exist-yet' });
		expect(sink).toBeInstanceOf(WinstonLogSink);
	});

	test('builds a real WinstonLogSink for a stdout-destination config', () => {
		const sink = createLogSinkFromConfig({ level: 'info' });
		expect(sink).toBeInstanceOf(WinstonLogSink);
	});
});
