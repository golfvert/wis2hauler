import { describe, expect, test } from 'bun:test';
import { createSourceLogger } from '../logger.ts';
import type { LogSink } from '../sink.ts';
import type { LevelGate } from '../logger.ts';
import type { LogLevel } from '../../config/runtime.ts';

function fakeSink() {
	const calls: { level: LogLevel; source: string; data: Record<string, unknown> }[] = [];
	const sink: LogSink = { write: (level, source, data) => calls.push({ level, source, data }) };
	return { sink, calls };
}

function fakeGate(defaultLevel: LogLevel, overrides: Partial<Record<string, LogLevel>> = {}): LevelGate {
	return { effectiveLevel: (role) => (role && overrides[role]) || defaultLevel };
}

describe('createSourceLogger', () => {
	test('slugifies the given name into the source tag written to the sink', () => {
		const { sink, calls } = fakeSink();
		const log = createSourceLogger('Correct ?', sink, fakeGate('debug'));
		log.info({ msg: 'hi' });
		expect(calls).toEqual([{ level: 'info', source: 'correct', data: { msg: 'hi' } }]);
	});

	test('a message is dropped when the level gate does not admit it', () => {
		const { sink, calls } = fakeSink();
		const log = createSourceLogger('Hash', sink, fakeGate('info'));
		log.warn({ msg: 'should be dropped' });
		log.info({ msg: 'kept' });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.data).toEqual({ msg: 'kept' });
	});

	test('a role-scoped logger consults the gate with its role, picking up a per-role override', () => {
		const { sink, calls } = fakeSink();
		const gate = fakeGate('info', { SUBSCRIBER: 'debug' });
		const subLog = createSourceLogger('Order links', sink, gate, 'SUBSCRIBER');
		const otherLog = createSourceLogger('Ack', sink, gate, 'DOWNLOADER');

		subLog.debug({ a: 1 });
		otherLog.debug({ b: 2 });

		expect(calls).toEqual([{ level: 'debug', source: 'orderlinks', data: { a: 1 } }]);
	});

	test('a role-agnostic logger (no role passed) only ever sees the process-wide default', () => {
		const { sink, calls } = fakeSink();
		const gate = fakeGate('info', { SUBSCRIBER: 'debug' });
		const log = createSourceLogger('Config', sink, gate);
		log.debug({ x: 1 });
		expect(calls).toHaveLength(0);
	});
});
