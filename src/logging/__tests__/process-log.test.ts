import { describe, expect, test } from 'bun:test';
import { createProcessLog } from '../process-log.ts';
import type { SourceLogger } from '../logger.ts';

function capture() {
	const calls: { level: string; data: Record<string, unknown> }[] = [];
	const logger: SourceLogger = {
		info: (d) => calls.push({ level: 'info', data: d }),
		warn: (d) => calls.push({ level: 'warn', data: d }),
		debug: (d) => calls.push({ level: 'debug', data: d }),
	};
	return { calls, log: createProcessLog(logger) };
}

describe('createProcessLog', () => {
	test('log/warn/error are all written at info level, with the original method kept as severity', () => {
		const { calls, log } = capture();
		log.log('DOWNLOADER: aria2 connected');
		log.warn('DOWNLOADER: aria2 disconnected');
		log.error('DOWNLOADER: poll failed: boom');
		expect(calls.map((c) => c.level)).toEqual(['info', 'info', 'info']);
		expect(calls.map((c) => c.data.severity)).toEqual(['info', 'warn', 'error']);
		expect(calls[1]!.data.message).toBe('DOWNLOADER: aria2 disconnected');
	});

	test('a trailing plain object becomes structured fields (dataId etc.) and is not part of the message', () => {
		const { calls, log } = capture();
		log.error('downloader: failed processing entry 1-0', { data_id: 'abc', entryId: '1-0' });
		expect(calls[0]!.data).toEqual({ data_id: 'abc', entryId: '1-0', severity: 'error', message: 'downloader: failed processing entry 1-0' });
	});

	test('fields cannot override severity or message; Error args use the stack', () => {
		const { calls, log } = capture();
		log.warn('x', { severity: 'info', message: 'nope' });
		expect(calls[0]!.data).toEqual({ severity: 'warn', message: 'x' });
		log.error(new Error('kaput'));
		expect(String(calls[1]!.data.message)).toContain('kaput');
	});
});
