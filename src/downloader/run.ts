// Top-level wiring for a live DOWNLOADER role: connects to Redis and
// aria2 (a single real WebSocket JSON-RPC connection -- see aria2.ts's
// header note on the maintainer's first AskUserQuestion decision), and publishes
// through the already-connected PUB1/PUB2 clients it's handed (reused
// from global.local-broker, same as Subscriber's publish-only outcome).
// Seeds config-file credentials once at startup, then keeps them synced
// every 10s (credentials.ts's "Credentials" HGETALL poll). Runs the main
// consumer loop (consumer.ts, 2s poll) and the Cleaner-IPC loop
// (cleaner-ipc.ts, its own separate 2s poll) concurrently until the
// given AbortSignal fires. This is what main.ts calls when global.roles
// includes DOWNLOADER -- see main.ts's RoleRunners for how this gets
// swapped for a fake in tests.
//
// DELIBERATE CHANGE, 2026-09-12: this used to open and close its own
// PUB1/PUB2 connections. the maintainer's call ("main.ts being the 'orchestrator'
// should manage all connection for both up and down"): main() now
// opens PUB1/PUB2 ONCE, shared with SUBSCRIBER when both roles are
// active on the same replica (they used to each open their own,
// wasteful and the root of a real client-id collision -- see mqtt/
// client.ts's connectMqtt doc comment) -- and closes them once every
// role has settled. This runner just publishes through what it's
// handed.
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection } from '../redis/ioredis-store.ts';
import { IoredisDownloaderStore } from '../redis/ioredis-downloader-store.ts';
import type { MqttLike } from '../mqtt/types.ts';
import { Aria2Client, type WebSocketLike } from './aria2.ts';
import { pollCredentials, seedCredentials, type CredentialMap } from './credentials.ts';
import { InFlightCounter, handleAriaNotification, runConsumerLoop, type ConsumerDeps } from './consumer.ts';
import { runCleanerIpcLoop, type CleanerIpcDeps } from './cleaner-ipc.ts';
import type { AriaStartDeps } from './aria-start.ts';
import type { ErrorRetryDeps } from './error-retry.ts';
import type { CompleteDeps } from './complete.ts';
import type { FinishingDeps } from './finishing.ts';
import type { DecodeWriteIO } from './decode-write.ts';
import type { HashConfig, HashIO } from './hash.ts';
import { createSourceLogger, type LevelGate } from '../logging/logger.ts';
import type { LogSink } from '../logging/sink.ts';

// credentials.ts's "Credentials" sync cadence -- a 10s inject, confirmed against flows.json.
const CREDENTIALS_POLL_INTERVAL_MS = 10000;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomSixDigits(): string {
	return String(Math.floor(Math.random() * 1000000));
}

export async function runDownloader(
	config: Config,
	debug: DebugController,
	log: typeof console,
	signal: AbortSignal,
	publishClients: MqttLike[],
	logSink?: LogSink,
	gate?: LevelGate,
): Promise<void> {
	const dl = config.downloader;
	if (!dl) throw new Error('runDownloader called without a downloader: config section (global.roles includes DOWNLOADER but validation should have caught this)');
	const queue = config.global.queue;
	if (!queue) throw new Error('runDownloader called without global.queue (validation should have caught this)');
	const worker = config.global.worker;

	const isDebugEnabled = () => debug.has('DOWNLOADER');

	// The 9 module loggers this role's ported logIO call sites need (10
	// sites -- "Publish" covers 2, its own Warn and Info -- see each Deps
	// interface's own doc comment for exactly which site each one is).
	// undefined (not built) when this runner is called without a
	// logSink/gate, e.g. from a test's own direct call.
	// Named "Publish" (renamed from "Link" 2026-09-16, see FinishingDeps.
	// publishLog's own doc comment), so it shares a log file with
	// Subscriber's own publish-only republish logger of the same name.
	const publishLog = logSink && gate ? createSourceLogger('Publish', logSink, gate, 'DOWNLOADER') : undefined;
	const requeueLog = logSink && gate ? createSourceLogger('Re-queue', logSink, gate, 'DOWNLOADER') : undefined;
	const updateLog = logSink && gate ? createSourceLogger('Update', logSink, gate, 'DOWNLOADER') : undefined;
	const correctLog = logSink && gate ? createSourceLogger('Correct ?', logSink, gate, 'DOWNLOADER') : undefined;
	const outputCompleteLog = logSink && gate ? createSourceLogger('Output - Complete', logSink, gate, 'DOWNLOADER') : undefined;
	const outputErrorLog = logSink && gate ? createSourceLogger('Output - Error', logSink, gate, 'DOWNLOADER') : undefined;
	const ackLog = logSink && gate ? createSourceLogger('Ack', logSink, gate, 'DOWNLOADER') : undefined;
	const duplicatesLog = logSink && gate ? createSourceLogger('Duplicates', logSink, gate, 'DOWNLOADER') : undefined;
	const ariaLog = logSink && gate ? createSourceLogger('Aria', logSink, gate, 'DOWNLOADER') : undefined;
	// NOT a port (2026-09-20): see consumer.ts's ConsumerDeps.errorLog doc
	// comment -- a file-backed home for pollOnce()'s per-entry catch,
	// which previously only ever reached plain console.error.
	const errorLog = logSink && gate ? createSourceLogger('Poll Error', logSink, gate, 'DOWNLOADER') : undefined;

	const redisConn = createRedisConnection(config.global.redis);
	const store = new IoredisDownloaderStore(redisConn);

	// Setup tab's "Queue" -> "XGROUP" node (b6dda43fbcd85817 /
	// 1b42b9c92f4352df): XGROUP CREATE <queue> <queue> $ MKSTREAM,
	// creating both the work-queue stream and its consumer group if
	// they don't exist yet (e.g. a freshly restarted/empty Redis
	// Cluster). Best-effort like the original (no downstream wire
	// depended on it, and ensureWorkQueueGroup() itself swallows a
	// re-run's expected BUSYGROUP) -- logged and NOT fatal on any other
	// error, since readWorkQueue() below will just keep failing with a
	// visible NOGROUP error per poll if this never succeeds, same
	// failure mode as before this fix, not a worse one.
	try {
		await store.ensureWorkQueueGroup(queue);
	} catch (err) {
		log.error(`DOWNLOADER: could not create work-queue consumer group (queue=${queue}): ${err instanceof Error ? err.message : String(err)} -- polling may keep failing until this is resolved`);
	}

	// Setup tab's one-time startup seed, then keep the in-memory
	// credentials map synced every 10s off the same hash (see
	// credentials.ts's header comment -- these are two DIFFERENT traced
	// flows.json chains that happen to share this file).
	await seedCredentials(store, dl.credentials as CredentialMap | undefined);
	let liveCredentials: CredentialMap | undefined = dl.credentials as CredentialMap | undefined;
	const refreshCredentials = async (): Promise<void> => {
		liveCredentials = await pollCredentials(store, (m) => log.warn(`DOWNLOADER: ${m}`));
	};
	await refreshCredentials();
	const credentialsTimer = setInterval(() => {
		void refreshCredentials().catch((err) => log.error(`DOWNLOADER: credential sync failed: ${err instanceof Error ? err.message : String(err)}`));
	}, CREDENTIALS_POLL_INTERVAL_MS);

	// PUB1/PUB2 (finishing.ts's cache-republish targets) are already
	// connected -- handed in by main.ts (the orchestrator), shared with
	// SUBSCRIBER when it's also active on this replica.

	// hash.ts's optional S3 relocate target (only built when configured --
	// uploadToS3 is only ever invoked when hashConfig.renameToS3 is true,
	// which itself requires downloader.rename-to === 's3", and validate.ts
	// already enforces s3access is present whenever that's the case).
	const s3Client = dl.s3access
		? new Bun.S3Client({
				accessKeyId: dl.s3access.accesskey,
				secretAccessKey: dl.s3access.secretkey,
				bucket: dl.s3access.bucket,
				endpoint: dl.s3access.url,
				region: dl.s3access.region,
			})
		: undefined;

	const hashConfig: HashConfig = {
		worker,
		downloadUrlBase: dl['download-url'],
		renameToDate: dl['rename-to'] === 'date',
		renameToTopic: dl['rename-to'] === 'topic',
		renameToS3: dl['rename-to'] === 's3',
		s3: dl.s3access ? { bucket: dl.s3access.bucket } : undefined,
		// 2026-09-13: this worker's own aria-download, so hash.ts can compute
		// HashResult.localPath relative to it -- see hash.ts's header comment
		// on why this replaced deriving it from a "downloads/" literal.
		ariaDownload: dl['aria-download'],
	};

	const hashIo: HashIO = {
		statSize: (filepath) => {
			try {
				return fs.statSync(filepath).size;
			} catch {
				return 0;
			}
		},
		dirname: (filepath) => nodePath.dirname(filepath),
		basename: (filepath) => nodePath.basename(filepath),
		join: (...parts) => nodePath.join(...parts),
		relative: (from, to) => nodePath.relative(from, to),
		mkdirRecursive: (dir) => {
			fs.mkdirSync(dir, { recursive: true });
		},
		exists: (filepath) => fs.existsSync(filepath),
		unlinkSync: (filepath) => fs.unlinkSync(filepath),
		renameSync: (oldPath, newPath) => fs.renameSync(oldPath, newPath),
		unlinkAsync: (filepath) => fs.promises.unlink(filepath),
		hashFileBase64: (filepath, method) =>
			new Promise((resolve, reject) => {
				let hash: ReturnType<typeof createHash>;
				try {
					hash = createHash(method);
				} catch (err) {
					reject(err);
					return;
				}
				const stream = fs.createReadStream(filepath);
				stream.on('data', (chunk) => hash.update(chunk));
				stream.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
				stream.on('end', () => resolve(hash.digest('base64')));
			}),
		isUnsupportedHashMethod: (err) => err instanceof Error && /digest method not supported|invalid digest|is not supported/i.test(err.message),
		now: () => Date.now(),
		uploadToS3: async (_bucket, objectName, filepath) => {
			if (!s3Client) throw new Error('uploadToS3 called without downloader.s3access configured');
			await s3Client.write(objectName, Bun.file(filepath));
		},
		warn: (m) => log.warn(`DOWNLOADER: ${m}`),
		error: (m) => log.error(`DOWNLOADER: ${m}`),
	};

	const decodeWriteIo: DecodeWriteIO = {
		mkdirRecursive: (dir) => {
			fs.mkdirSync(dir, { recursive: true });
		},
		join: (...parts) => nodePath.join(...parts),
		dirname: (filepath) => nodePath.dirname(filepath),
		writeFileSync: (filepath, data) => fs.writeFileSync(filepath, data),
		gunzipSync: (data) => new Uint8Array(gunzipSync(data)),
		base64Decode: (value) => new Uint8Array(Buffer.from(value, 'base64')),
		utf8Encode: (value) => new Uint8Array(Buffer.from(value, 'utf-8')),
		hashBase64: (method, data) => createHash(method).update(data).digest('base64'),
		randomStreamSuffix: randomSixDigits,
		warn: (m) => log.warn(`DOWNLOADER: ${m}`),
	};

	// aria2 -- see aria2.ts's header note: ONE real WebSocket connection,
	// correlating every request/response by JSON-RPC "id" (the maintainer's first
	// AskUserQuestion decision this phase). onNotification below closes
	// over consumerDeps, defined further down this function -- safe
	// because it's only ever invoked once aria2 actually pushes a
	// notification, long after consumerDeps is assigned.
	const aria2 = new Aria2Client({
		url: dl['aria-url'],
		secret: dl['aria-secret'],
		createWebSocket: (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike,
		onConnect: () => log.log('DOWNLOADER: aria2 connected'),
		onDisconnect: () => log.warn('DOWNLOADER: aria2 disconnected'),
		onWarning: (m) => log.warn(`DOWNLOADER: aria2: ${m}`),
		onNotification: (notification) => {
			// A catch-all: handleAriaNotification runs tellStatus, ack,
			// hash verification, and (on HASH_OK) the whole Finishing
			// chain including a local-broker publish -- any of those can
			// throw, not just something about the notification itself.
			// Named generically on purpose, not "aria2 notification
			// handling failed": that wording read as if the notification
			// was the problem (observed live, the maintainer, 2026-09-10, when the
			// actual failure was finishing.ts's local-broker publish
			// rejecting because the broker wasn't connected) -- the
			// specific failure is now named precisely at its own source
			// (see finishing.ts's publish-loop wrapping) and surfaces
			// here via its own error message regardless of this generic
			// wrapper text.
			void handleAriaNotification(consumerDeps, notification, (gid) => aria2.tellStatus(gid)).catch((err) =>
				log.error(`DOWNLOADER: post-download processing failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		},
	});
	aria2.start();

	const ariaStart: AriaStartDeps = {
		store,
		worker,
		aria2,
		credentials: () => liveCredentials,
		checkCertificate: dl['aria-check-tls'],
		randomStreamSuffix: randomSixDigits,
		ariaLog,
	};

	const errorRetry: ErrorRetryDeps = {
		store,
		queue,
		worker,
		ariaStart,
		sleep: defaultSleep,
		mintRequeueId: () => `${Date.now()}-99-${randomSixDigits()}`,
		requeueLog,
		updateLog,
	};

	const complete: CompleteDeps = {
		store,
		worker,
		hashConfig,
		hashIo,
		newUuid: () => randomUUID(),
		duplicatesLog,
	};

	const finishing: FinishingDeps = {
		store,
		worker,
		centreId: config.global['centre-id'] ?? '',
		publishClients,
		publishLog,
		error: (m) => log.error(`DOWNLOADER: ${m}`),
	};

	const consumerDeps: ConsumerDeps = {
		store,
		queue,
		worker,
		ariaInQueue: dl['aria-inqueue'],
		inFlight: new InFlightCounter(),
		ariaDownloadDir: dl['aria-download'],
		decodeWriteIo,
		ariaStart,
		complete,
		finishing,
		errorRetry,
		log,
		correctLog,
		outputCompleteLog,
		outputErrorLog,
		ackLog,
		errorLog,
	};

	const cleanerIpc: CleanerIpcDeps = {
		store,
		queue,
		worker,
		errorRetry,
		ariaDownloadDir: dl['aria-download'],
		unlinkAsync: (filepath) => fs.promises.unlink(filepath),
		warn: (m) => log.warn(`DOWNLOADER: ${m}`),
		sleep: defaultSleep,
	};

	if (isDebugEnabled()) log.log(`DOWNLOADER: aria-inqueue=${dl['aria-inqueue']} download-url=${dl['download-url'] ?? 'none'} rename-to=${dl['rename-to'] ?? 'none'}`);

	log.log('DOWNLOADER: consumer + cleaner-ipc loops starting');
	await Promise.allSettled([runConsumerLoop(consumerDeps, signal, defaultSleep), runCleanerIpcLoop(cleanerIpc, signal)]);
	log.log('DOWNLOADER: shutdown signalled, closing connections');

	clearInterval(credentialsTimer);
	aria2.stop();
	// publishClients is NOT closed here -- main.ts (the orchestrator)
	// owns its whole lifecycle, since it may be shared with a
	// concurrently-running SUBSCRIBER on this same replica.
	await store.quit();
}
