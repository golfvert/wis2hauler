// Port of the "Hash" function node (Downloader tab, id 1a867ae19b2242d5):
// file-integrity verification + rename/relocate (by date, by topic, or to
// S3) for a completed aria2 (or embedded-content) download.
//
// FIDELITY NOTES (all derived from reading the literal source, not
// inferred):
//   - A hash MISMATCH, a rename-target name COLLISION (date/topic), and an
//     UNSUPPORTED hash method are all deliberate, already-handled outcomes
//     in the original (HASH_NOK / FAIL, explicit `return`s) -- ported here
//     as ordinary return values, never thrown.
//   - A genuine filesystem failure during date/topic renaming (mkdirSync/
//     renameSync throwing) is thrown by handleRename() SYNCHRONOUSLY,
//     which happens *during the evaluation of the argument* to
//     `Promise.resolve(handleRename())` in the original -- i.e. BEFORE any
//     `.then/.catch` exists to attach to. That makes it a genuine uncaught
//     exception in the original, caught only by the Downloader tab's
//     "Duplicates" catch node, which just logs and drops the job. Per
//     the maintainer's explicit decision (this phase's second AskUserQuestion), the
//     Bun port does NOT reproduce the silent drop: this function THROWS a
//     RenameIoError, and the caller (the not-yet-written orchestration
//     that calls runHash after a completed download) is responsible for
//     catching it and routing the job into the same retry/error pipeline
//     as a HASH_NOK.
//   - A read error on the file being hashed similarly rejects the
//     function's returned Promise in the original
//     (`stream.on('error', ... reject(msg))`), which Node-RED also treats
//     as a node error routed to the same "Duplicates" catch node -- ported
//     the same way: throws a HashReadError for the caller to route into
//     retry/error.
//   - An S3 upload failure, by contrast, IS already caught locally by the
//     original's own `.catch(err => { ...; msg.payload = "FAIL"; })` --
//     that catch is attached to a real rejected Promise (the S3 branch of
//     handleRename literally does `return new Promise((resolve, reject) =>
//     ... reject(...))`), so it never reaches the "Duplicates" catch node
//     in the first place. Ported as-is: an S3 failure resolves to a
//     'FAIL' outcome, not a throw.

export type HashOutcome = 'HASH_OK' | 'HASH_NOK' | 'FAIL';

export class RenameIoError extends Error {}
export class HashReadError extends Error {}

export interface HashInput {
	/** msg.method -- the integrity method (e.g. "sha512"), or null/undefined to skip verification entirely. */
	method: string | null | undefined;
	/** msg.hash -- the expected base64 digest, or the number 0 when the original had no integrity block to check against. */
	hash: string | number;
	/** msg.status.result.files[0].path -- the file aria2 (or Decode & Write) produced on disk. */
	filepath: string;
	wnmpubtime?: string;
	wnmtopic?: string;
}

export interface HashConfig {
	worker: string; // global "worker"
	downloadUrlBase: string; // global "download-url"
	renameToDate: boolean;
	renameToTopic: boolean;
	renameToS3: boolean;
	s3?: {
		bucket: string;
	};
}

export interface HashResult {
	outcome: HashOutcome;
	length: number;
	/** Only set when outcome === 'HASH_OK'. */
	localhref?: string;
	uri?: string;
}

export interface HashIO {
	/** fs.statSync(filepath).size, or 0 if the stat fails -- matches the original's own try/catch. */
	statSize(filepath: string): number;
	dirname(filepath: string): string;
	basename(filepath: string): string;
	join(...parts: string[]): string;
	mkdirRecursive(dir: string): void;
	exists(filepath: string): boolean;
	unlinkSync(filepath: string): void;
	renameSync(oldPath: string, newPath: string): void;
	unlinkAsync(filepath: string): Promise<void>;
	/**
	 * Streams `filepath` through the named hash algorithm and resolves the
	 * base64 digest. Rejects on a stream read failure (matches
	 * `stream.on('error', ...)`) or if `method` itself is not a supported
	 * digest (matches `crypto.createHash(method)` throwing synchronously) --
	 * isUnsupportedHashMethod is how the caller tells the two apart.
	 */
	hashFileBase64(filepath: string, method: string): Promise<string>;
	isUnsupportedHashMethod(err: unknown): boolean;
	uploadToS3(bucket: string, objectName: string, filepath: string): Promise<void>;
	warn(message: string): void;
	error(message: string): void;
}

/** The date-rename directory name, formatted exactly as the original: "YYYY/MM/DD/HH". */
export function formatDateDir(wnmpubtime: string): string {
	return new Date(wnmpubtime).toISOString().slice(0, 13).replace('T', '/').replace(/-/g, '/');
}

/** The topic-rename directory name: everything after the topic's first 3 "/"-segments. */
export function formatTopicDir(wnmtopic: string): string {
	return wnmtopic.split('/').slice(3).join('/');
}

interface RenameOutcome {
	renamed: boolean;
	failed: boolean;
	filepath: string;
}

async function handleRename(filepath: string, input: HashInput, config: HashConfig, io: HashIO): Promise<RenameOutcome> {
	if (config.renameToDate && input.wnmpubtime) {
		try {
			const baseDir = io.dirname(filepath);
			const filename = io.basename(filepath);
			const dateDir = io.join(baseDir, formatDateDir(input.wnmpubtime));
			io.mkdirRecursive(dateDir);
			const newFilepath = io.join(dateDir, filename);
			if (io.exists(newFilepath)) {
				io.unlinkSync(filepath);
				return { renamed: false, failed: true, filepath };
			}
			io.renameSync(filepath, newFilepath);
			return { renamed: true, failed: false, filepath: newFilepath };
		} catch (err) {
			throw new RenameIoError(`Failed to move file to date directory: ${(err as Error).message}`);
		}
	} else if (config.renameToTopic && input.wnmtopic) {
		try {
			const baseDir = io.dirname(filepath);
			const filename = io.basename(filepath);
			const topicDir = io.join(baseDir, formatTopicDir(input.wnmtopic));
			io.mkdirRecursive(topicDir);
			const newFilepath = io.join(topicDir, filename);
			if (io.exists(newFilepath)) {
				io.unlinkSync(filepath);
				return { renamed: false, failed: true, filepath };
			}
			io.renameSync(filepath, newFilepath);
			return { renamed: true, failed: false, filepath: newFilepath };
		} catch (err) {
			throw new RenameIoError(`Failed to move file to topic directory: ${(err as Error).message}`);
		}
	} else if (config.renameToS3) {
		try {
			const objectName = io.basename(filepath);
			await io.uploadToS3(config.s3?.bucket ?? '', objectName, filepath);
			try {
				await io.unlinkAsync(filepath);
			} catch (unlinkErr) {
				io.warn(`Uploaded to S3 but failed to delete local file: ${(unlinkErr as Error).message}`);
			}
			return { renamed: true, failed: false, filepath };
		} catch {
			// matches the original's local .catch(err => { msg.payload = "FAIL"; }) -- an
			// S3 failure resolves to FAIL, it never escapes as an uncaught exception.
			return { renamed: false, failed: true, filepath };
		}
	}

	return { renamed: false, failed: false, filepath };
}

function buildLocalHrefAndUri(filepath: string, config: HashConfig, io: HashIO): { localhref: string; uri: string } {
	if (config.renameToS3) {
		const basename = io.basename(filepath);
		return { localhref: `${config.downloadUrlBase}/${basename}`, uri: basename };
	}
	return { localhref: `${config.downloadUrlBase}/${config.worker}${filepath}`, uri: filepath };
}

function warnIfNotRenamed(result: RenameOutcome, input: HashInput, config: HashConfig, io: HashIO): void {
	if (!result.renamed && (config.renameToDate || config.renameToTopic || config.renameToS3)) {
		io.warn(
			`File NOT renamed: ${result.filepath} | renameToDate: ${config.renameToDate}, wnmpubtime: ${input.wnmpubtime ? 'present' : 'MISSING'} | renameToTopic: ${config.renameToTopic}, wnmtopic: ${input.wnmtopic ?? 'MISSING'} | renameToS3: ${config.renameToS3}`,
		);
	}
}

export async function runHash(input: HashInput, config: HashConfig, io: HashIO): Promise<HashResult> {
	const length = io.statSize(input.filepath);

	// method === null/undefined -- skip hashing entirely, still try to rename.
	if (input.method === null || input.method === undefined) {
		const result = await handleRename(input.filepath, input, config, io);
		if (result.failed) {
			return { outcome: 'FAIL', length };
		}
		warnIfNotRenamed(result, input, config, io);
		return { outcome: 'HASH_OK', length, ...buildLocalHrefAndUri(result.filepath, config, io) };
	}

	let digestBase64: string;
	try {
		digestBase64 = await io.hashFileBase64(input.filepath, input.method);
	} catch (err) {
		if (io.isUnsupportedHashMethod(err)) {
			return { outcome: 'HASH_NOK', length };
		}
		throw new HashReadError(`Failed to read or hash the file: ${(err as Error).message}`);
	}

	if (digestBase64 === input.hash || input.hash === 0) {
		const result = await handleRename(input.filepath, input, config, io);
		if (result.failed) {
			return { outcome: 'FAIL', length };
		}
		warnIfNotRenamed(result, input, config, io);
		return { outcome: 'HASH_OK', length, ...buildLocalHrefAndUri(result.filepath, config, io) };
	}

	try {
		await io.unlinkAsync(input.filepath);
	} catch (err) {
		io.error(`Failed to delete file with incorrect hash: ${(err as Error).message}`);
	}
	return { outcome: 'HASH_NOK', length };
}
