import { describe, expect, test } from 'bun:test';
import { runDecodeWrite, type DecodeWriteIO } from '../decode-write.ts';

function makeIo(overrides: Partial<DecodeWriteIO> = {}): { io: DecodeWriteIO; writes: { filepath: string; data: Uint8Array }[]; mkdirs: string[]; warnings: string[] } {
	const writes: { filepath: string; data: Uint8Array }[] = [];
	const mkdirs: string[] = [];
	const warnings: string[] = [];
	const io: DecodeWriteIO = {
		mkdirRecursive: (dir) => {
			mkdirs.push(dir);
		},
		join: (...parts) => parts.join('/'),
		dirname: (filepath) => filepath.split('/').slice(0, -1).join('/'),
		writeFileSync: (filepath, data) => {
			writes.push({ filepath, data });
		},
		gunzipSync: (data) => data,
		base64Decode: (value) => new TextEncoder().encode(Buffer.from(value, 'base64').toString('utf8')),
		utf8Encode: (value) => new TextEncoder().encode(value),
		hashBase64: () => 'matching-digest',
		randomStreamSuffix: () => '123456',
		warn: (message) => {
			warnings.push(message);
		},
		...overrides,
	};
	return { io, writes, mkdirs, warnings };
}

const entry = { id: '1694198400000-0', downloaderId: 'wis2:centre:1234', href: 'https://example.com/foo/bar.grib2' };

describe('runDecodeWrite', () => {
	test('utf-8 content with no integrity block is written to disk and a synthetic gid is minted', () => {
		const { io, writes, mkdirs } = makeIo();
		const wnmJson = JSON.stringify({ properties: { content: { encoding: 'utf-8', value: 'hello world' } } });

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome.kind).toBe('written');
		if (outcome.kind !== 'written') throw new Error('unreachable');
		expect(outcome.gid).toBe('1694198400000-0-123456');
		expect(outcome.filename).toBe('1234_bar.grib2');
		expect(outcome.filepath).toBe('/downloads/1234_bar.grib2');
		expect(mkdirs).toEqual(['/downloads']);
		expect(writes).toHaveLength(1);
		expect(writes[0]!.filepath).toBe('/downloads/1234_bar.grib2');
		expect(new TextDecoder().decode(writes[0]!.data)).toBe('hello world');
	});

	test('base64 content is decoded before writing', () => {
		const { io, writes } = makeIo();
		const wnmJson = JSON.stringify({ properties: { content: { encoding: 'base64', value: Buffer.from('binary payload').toString('base64') } } });

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome.kind).toBe('written');
		expect(new TextDecoder().decode(writes[0]!.data)).toBe('binary payload');
	});

	test('gzip content is base64-decoded then gunzipped', () => {
		const { io, writes } = makeIo({ gunzipSync: (data) => new TextEncoder().encode(`gunzipped:${new TextDecoder().decode(data)}`) });
		const wnmJson = JSON.stringify({ properties: { content: { encoding: 'gzip', value: Buffer.from('compressed').toString('base64') } } });

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome.kind).toBe('written');
		expect(new TextDecoder().decode(writes[0]!.data)).toBe('gunzipped:compressed');
	});

	test('an integrity mismatch falls back without writing to disk', () => {
		const { io, writes, warnings } = makeIo({ hashBase64: () => 'wrong-digest' });
		const wnmJson = JSON.stringify({
			properties: {
				content: { encoding: 'utf-8', value: 'hello' },
				integrity: { method: 'sha256', value: 'expected-digest' },
			},
		});

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome).toEqual({ kind: 'fallback' });
		expect(writes).toHaveLength(0);
		expect(warnings).toHaveLength(1);
	});

	test('a matching integrity value proceeds to write', () => {
		const { io, writes } = makeIo({ hashBase64: () => 'expected-digest' });
		const wnmJson = JSON.stringify({
			properties: {
				content: { encoding: 'utf-8', value: 'hello' },
				integrity: { method: 'sha256', value: 'expected-digest' },
			},
		});

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome.kind).toBe('written');
		expect(writes).toHaveLength(1);
	});

	test('missing properties.content falls back and warns', () => {
		const { io, warnings } = makeIo();
		const outcome = runDecodeWrite(entry, JSON.stringify({ properties: {} }), '/downloads', io);

		expect(outcome).toEqual({ kind: 'fallback' });
		expect(warnings).toHaveLength(1);
	});

	test('malformed wnm JSON falls back rather than throwing', () => {
		const { io, warnings } = makeIo();
		const outcome = runDecodeWrite(entry, 'not json', '/downloads', io);

		expect(outcome).toEqual({ kind: 'fallback' });
		expect(warnings).toHaveLength(1);
	});

	test('an fs error during write falls back rather than throwing', () => {
		const { io, warnings } = makeIo({
			writeFileSync: () => {
				throw new Error('disk full');
			},
		});
		const wnmJson = JSON.stringify({ properties: { content: { encoding: 'utf-8', value: 'hello' } } });

		const outcome = runDecodeWrite(entry, wnmJson, '/downloads', io);

		expect(outcome).toEqual({ kind: 'fallback' });
		expect(warnings).toHaveLength(1);
	});
});
