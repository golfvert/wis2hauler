import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WinstonLogSink } from '../sink.ts';

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function waitForLine(dir: string, suffix: string): Promise<Record<string, unknown>> {
	for (let i = 0; i < 50; i++) {
		const file = readdirSync(dir).find((f) => f.startsWith('hauler-') && f.endsWith(suffix));
		const text = file ? readFileSync(join(dir, file), 'utf8').trim() : '';
		if (text) return JSON.parse(text.split('\n')[0]!) as Record<string, unknown>;
		await new Promise((r) => setTimeout(r, 40));
	}
	throw new Error(`no log line in ${dir} for ${suffix}`);
}

describe('WinstonLogSink file output', () => {
	test('writes hauler-<source>-<date-hour>.<level>.log with logger, level and timestamp alongside the data', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hauler-sink-'));
		dirs.push(dir);
		const sink = new WinstonLogSink({ destination: 'file', logDir: dir });

		sink.write('debug', 'decision', { action: 'download', data_id: 'd1' });

		const line = await waitForLine(dir, '.debug.log');
		expect(line.logger).toBe('decision');
		expect(line.level).toBe('debug');
		expect(line.action).toBe('download');
		expect(line.data_id).toBe('d1');
		expect(typeof line.timestamp).toBe('string');
		expect(readdirSync(dir).some((f) => /^hauler-decision-\d{4}-\d{2}-\d{2}-\d{2}\.debug\.log$/.test(f))).toBe(true);
	});

	test('stamps the configured worker on every line, and omits the field when none is configured', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hauler-sink-'));
		dirs.push(dir);
		new WinstonLogSink({ destination: 'file', logDir: dir, worker: 'five' }).write('debug', 'filter', { outcome: 'ingested' });
		const line = await waitForLine(dir, '.debug.log');
		expect(line.worker).toBe('five');
		expect(line.logger).toBe('filter');

		const dir2 = mkdtempSync(join(tmpdir(), 'hauler-sink-'));
		dirs.push(dir2);
		new WinstonLogSink({ destination: 'file', logDir: dir2 }).write('debug', 'filter', { outcome: 'ingested' });
		const line2 = await waitForLine(dir2, '.debug.log');
		expect('worker' in line2).toBe(false);
	});

	test("a data field named 'source' (Received/Filter's GB1/GB2) is untouched by the logger name", async () => {
		const dir = mkdtempSync(join(tmpdir(), 'hauler-sink-'));
		dirs.push(dir);
		const sink = new WinstonLogSink({ destination: 'file', logDir: dir });

		sink.write('debug', 'received', { source: 'GB1', topic: 't' });

		const line = await waitForLine(dir, '.debug.log');
		expect(line.logger).toBe('received');
		expect(line.source).toBe('GB1');
	});
});
