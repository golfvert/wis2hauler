import { describe, expect, test } from 'bun:test';
import { formatDateDir, formatTopicDir, HashReadError, RenameIoError, runHash, type HashConfig, type HashIO } from '../hash';

class UnsupportedMethodError extends Error {}
class StreamReadError extends Error {}

function makeIo(overrides: Partial<HashIO> = {}): HashIO & { warnings: string[]; errors: string[]; calls: string[] } {
	const files = new Map<string, number>([['/downloads/file.dat', 42]]);
	const dirs = new Set<string>();
	const warnings: string[] = [];
	const errors: string[] = [];
	const calls: string[] = [];

	const base: HashIO & { warnings: string[]; errors: string[]; calls: string[] } = {
		warnings,
		errors,
		calls,
		statSize(filepath) {
			return files.get(filepath) ?? 0;
		},
		dirname(filepath) {
			return filepath.slice(0, filepath.lastIndexOf('/')) || '/';
		},
		basename(filepath) {
			return filepath.slice(filepath.lastIndexOf('/') + 1);
		},
		join(...parts) {
			return parts.join('/').replace(/\/+/g, '/');
		},
		mkdirRecursive(dir) {
			calls.push(`mkdir:${dir}`);
			dirs.add(dir);
		},
		exists(filepath) {
			return files.has(filepath);
		},
		unlinkSync(filepath) {
			calls.push(`unlinkSync:${filepath}`);
			files.delete(filepath);
		},
		renameSync(oldPath, newPath) {
			calls.push(`rename:${oldPath}->${newPath}`);
			const size = files.get(oldPath) ?? 0;
			files.delete(oldPath);
			files.set(newPath, size);
		},
		async unlinkAsync(filepath) {
			calls.push(`unlinkAsync:${filepath}`);
			files.delete(filepath);
		},
		async hashFileBase64() {
			return 'DEADBEEF==';
		},
		isUnsupportedHashMethod(err) {
			return err instanceof UnsupportedMethodError;
		},
		async uploadToS3(bucket, objectName) {
			calls.push(`s3:${bucket}/${objectName}`);
		},
		warn(message) {
			warnings.push(message);
		},
		error(message) {
			errors.push(message);
		},
	};

	return Object.assign(base, overrides);
}

const noRenameConfig: HashConfig = {
	worker: 'w1',
	downloadUrlBase: 'http://example.test/dl',
	renameToDate: false,
	renameToTopic: false,
	renameToS3: false,
};

describe('formatDateDir / formatTopicDir', () => {
	test('formatDateDir produces YYYY/MM/DD/HH from an ISO pubtime', () => {
		expect(formatDateDir('2024-01-15T10:23:45.678Z')).toBe('2024/01/15/10');
	});

	test('formatTopicDir drops the first 3 "/"-segments of the topic', () => {
		expect(formatTopicDir('origin/a/wis2/de-dwd/data/core/weather')).toBe('de-dwd/data/core/weather');
	});
});

describe('runHash', () => {
	test('method null/undefined, no rename configured -> HASH_OK using worker-prefixed localhref', async () => {
		const io = makeIo();
		const result = await runHash({ method: null, hash: 0, filepath: '/downloads/file.dat' }, noRenameConfig, io);
		expect(result).toEqual({
			outcome: 'HASH_OK',
			length: 42,
			localhref: 'http://example.test/dl/w1/downloads/file.dat',
			uri: '/downloads/file.dat',
		});
		expect(io.calls).toEqual([]);
	});

	test('renameToDate with pubtime, no collision -> renames into YYYY/MM/DD/HH, HASH_OK reflects new path', async () => {
		const io = makeIo();
		const config: HashConfig = { ...noRenameConfig, renameToDate: true };
		const result = await runHash(
			{ method: null, hash: 0, filepath: '/downloads/file.dat', wnmpubtime: '2024-01-15T10:23:45.678Z' },
			config,
			io,
		);
		expect(result.outcome).toBe('HASH_OK');
		expect(result.uri).toBe('/downloads/2024/01/15/10/file.dat');
		expect(result.localhref).toBe('http://example.test/dl/w1/downloads/2024/01/15/10/file.dat');
		expect(io.calls).toContain('rename:/downloads/file.dat->/downloads/2024/01/15/10/file.dat');
	});

	test('renameToDate collision at the destination -> FAIL, original file removed', async () => {
		const io = makeIo();
		// pre-seed the destination so it "already exists"
		io.exists = (p: string) => p === '/downloads/2024/01/15/10/file.dat' || p === '/downloads/file.dat';
		const config: HashConfig = { ...noRenameConfig, renameToDate: true };
		const result = await runHash(
			{ method: null, hash: 0, filepath: '/downloads/file.dat', wnmpubtime: '2024-01-15T10:23:45.678Z' },
			config,
			io,
		);
		expect(result.outcome).toBe('FAIL');
		expect(io.calls).toContain('unlinkSync:/downloads/file.dat');
		expect(io.calls.some((c) => c.startsWith('rename:'))).toBe(false);
	});

	test('a genuine fs failure during date-rename throws RenameIoError (per the maintainer: routed to retry by the caller, never silently dropped)', async () => {
		const io = makeIo({
			mkdirRecursive() {
				throw new Error('EACCES: permission denied');
			},
		});
		const config: HashConfig = { ...noRenameConfig, renameToDate: true };
		await expect(
			runHash(
				{ method: null, hash: 0, filepath: '/downloads/file.dat', wnmpubtime: '2024-01-15T10:23:45.678Z' },
				config,
				io,
			),
		).rejects.toBeInstanceOf(RenameIoError);
	});

	test('renameToTopic strips the topic\'s first 3 segments into the directory tree', async () => {
		const io = makeIo();
		const config: HashConfig = { ...noRenameConfig, renameToTopic: true };
		const result = await runHash(
			{ method: null, hash: 0, filepath: '/downloads/file.dat', wnmtopic: 'origin/a/wis2/de-dwd/data/core/weather' },
			config,
			io,
		);
		expect(result.outcome).toBe('HASH_OK');
		expect(result.uri).toBe('/downloads/de-dwd/data/core/weather/file.dat');
	});

	test('rename flag set but the matching field (wnmpubtime/wnmtopic) is missing -> not renamed, warns, still HASH_OK', async () => {
		const io = makeIo();
		const config: HashConfig = { ...noRenameConfig, renameToDate: true };
		const result = await runHash({ method: null, hash: 0, filepath: '/downloads/file.dat' }, config, io);
		expect(result.outcome).toBe('HASH_OK');
		expect(result.uri).toBe('/downloads/file.dat');
		expect(io.warnings).toHaveLength(1);
		expect(io.warnings[0]).toContain('File NOT renamed');
	});

	test('matching hash -> HASH_OK (goes through the same rename logic as the no-method path)', async () => {
		const io = makeIo();
		const result = await runHash(
			{ method: 'sha512', hash: 'DEADBEEF==', filepath: '/downloads/file.dat' },
			noRenameConfig,
			io,
		);
		expect(result.outcome).toBe('HASH_OK');
	});

	test('hash === 0 short-circuits the digest comparison (no integrity block was declared)', async () => {
		const io = makeIo({ async hashFileBase64() { return 'anything-at-all'; } });
		const result = await runHash({ method: 'sha512', hash: 0, filepath: '/downloads/file.dat' }, noRenameConfig, io);
		expect(result.outcome).toBe('HASH_OK');
	});

	test('hash mismatch -> HASH_NOK, file deleted asynchronously', async () => {
		const io = makeIo({ async hashFileBase64() { return 'WRONG=='; } });
		const result = await runHash(
			{ method: 'sha512', hash: 'DEADBEEF==', filepath: '/downloads/file.dat' },
			noRenameConfig,
			io,
		);
		expect(result).toEqual({ outcome: 'HASH_NOK', length: 42 });
		expect(io.calls).toContain('unlinkAsync:/downloads/file.dat');
	});

	test('hash mismatch where the async delete itself fails -> still resolves HASH_NOK, logs the delete error', async () => {
		const io = makeIo({
			async hashFileBase64() {
				return 'WRONG==';
			},
			async unlinkAsync() {
				throw new Error('ENOENT');
			},
		});
		const result = await runHash(
			{ method: 'sha512', hash: 'DEADBEEF==', filepath: '/downloads/file.dat' },
		noRenameConfig,
		io,
		);
		expect(result.outcome).toBe('HASH_NOK');
		expect(io.errors).toHaveLength(1);
	});

	test('unsupported hash method -> HASH_NOK, no delete attempted', async () => {
		const io = makeIo({
			async hashFileBase64() {
				throw new UnsupportedMethodError('unsupported');
			},
		});
		const result = await runHash({ method: 'not-a-real-algo', hash: 'x', filepath: '/downloads/file.dat' }, noRenameConfig, io);
		expect(result).toEqual({ outcome: 'HASH_NOK', length: 42 });
		expect(io.calls).not.toContain('unlinkAsync:/downloads/file.dat');
	});

	test('a stream read error while hashing throws HashReadError (routed to retry by the caller)', async () => {
		const io = makeIo({
			async hashFileBase64() {
				throw new StreamReadError('EIO');
			},
		});
		await expect(
			runHash({ method: 'sha512', hash: 'x', filepath: '/downloads/file.dat' }, noRenameConfig, io),
		).rejects.toBeInstanceOf(HashReadError);
	});

	test('renameToS3 success -> HASH_OK with a bucket-relative localhref/uri, uploads then deletes the local copy', async () => {
		const io = makeIo();
		const config: HashConfig = { ...noRenameConfig, renameToS3: true, s3: { bucket: 'my-bucket' } };
		const result = await runHash({ method: null, hash: 0, filepath: '/downloads/file.dat' }, config, io);
		expect(result.outcome).toBe('HASH_OK');
		expect(result.localhref).toBe('http://example.test/dl/file.dat');
		expect(result.uri).toBe('file.dat');
		expect(io.calls).toContain('s3:my-bucket/file.dat');
		expect(io.calls).toContain('unlinkAsync:/downloads/file.dat');
	});

	test('renameToS3 upload failure resolves to FAIL (NOT a throw -- the original already catches this one locally)', async () => {
		const io = makeIo({
			async uploadToS3() {
				throw new Error('S3 unreachable');
			},
		});
		const config: HashConfig = { ...noRenameConfig, renameToS3: true, s3: { bucket: 'my-bucket' } };
		const result = await runHash({ method: null, hash: 0, filepath: '/downloads/file.dat' }, config, io);
		expect(result.outcome).toBe('FAIL');
	});

	test('S3 upload succeeds but the post-upload local delete fails -> still HASH_OK, warns instead of failing', async () => {
		const io = makeIo({
			async unlinkAsync() {
				throw new Error('EBUSY');
			},
		});
		const config: HashConfig = { ...noRenameConfig, renameToS3: true, s3: { bucket: 'my-bucket' } };
		const result = await runHash({ method: null, hash: 0, filepath: '/downloads/file.dat' }, config, io);
		expect(result.outcome).toBe('HASH_OK');
		expect(io.warnings).toHaveLength(1);
		expect(io.warnings[0]).toContain('Uploaded to S3 but failed to delete local file');
	});
});
