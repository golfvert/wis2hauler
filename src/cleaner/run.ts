// Top-level wiring for a live CLEANER role: connects to Redis (one
// command connection, one dedicated psubscribe connection -- a Redis
// connection in subscribe mode can't issue ordinary commands, same
// reasoning as any other pub/sub client), and runs its 5 concurrent
// loops until the given AbortSignal fires:
//   - Election (../election/elector.ts, shared primitive, 10s poll,
//     role="cleaner") -- also derives cleaning-needed via
//     computeCleaningNeeded() from the same parsed worker map.
//   - Schedule (schedule.ts) -- event-driven off the "Cleaner" redis-in
//     psubscribe node (a8a76a5fc30cc193, pattern
//     "wis2gc:cleaner-reporter:*"), gated on (primary && cleaning-needed).
//   - Sweep (sweep.ts) -- 2s poll (onceDelay 7s), gated on
//     (primary && cleaning-needed), over BOTH cleanerPendingKey() and
//     cleanerCancelKey().
//   - Poll Errors (errors.ts) -- 5s poll, gated on primary only (no
//     cleaning-needed check, matching bc606cd68ed70ca1's condition).
//   - Clean Redis GC (gc.ts) -- 6h poll (onceDelay 100ms), gated on
//     primary only (matching 2ae60817cedd9bde's condition, which also
//     omits cleaning-needed).
//
// NOT ported: the Elect function's config_valid/process-mode gate on
// itself (fdfada5317311cb9 "Cleaner" switch) -- same unstated
// precedent as downloader/consumer.ts's "Ready ?" gate: this file is
// only ever invoked once main.ts has already confirmed the config is
// valid and CLEANER is an active role, which is what that gate existed
// to wait for. process-mode itself (config/runtime.ts's 'run'|'halt')
// has no owner anywhere yet in this port -- deferred, like the rest of
// the live-patch HTTP API, to a later phase.
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection } from '../redis/ioredis-store.ts';
import { IoredisCleanerStore, IoredisGcStore } from '../redis/ioredis-cleaner-store.ts';
import { IoredisElectionStore } from '../redis/ioredis-election-store.ts';
import { runElectionLoop } from '../election/elector.ts';
import { computeCleaningNeeded } from '../election/elect.ts';
import { decideSchedule, computeDownloadsMarker, type ScheduleConfig } from './schedule.ts';
import { SWEEP_ONCE_DELAY_S, SWEEP_INTERVAL_S, planSweepJob, type SweepJob } from './sweep.ts';
import { processErrors, type XreadReply } from './errors.ts';
import { GC_ONCE_DELAY_MS, GC_INTERVAL_MS, GC_DEFAULT_THRESHOLD_SECONDS, runGcSweep } from './gc.ts';
import { cleanerCancelKey, cleanerPendingKey, cleanerReporterKey } from '../wis2/redis-keys.ts';
import { createSourceLogger, type LevelGate } from '../logging/logger.ts';
import type { LogSink } from '../logging/sink.ts';

// "Poll Errors" inject: onceDelay 0.1s, repeat 5s.
const POLL_ERRORS_ONCE_DELAY_MS = 100;
const POLL_ERRORS_INTERVAL_MS = 5000;
// The Setup tab's "Configuration" change node (ec251329e6d67f9d) initializes global.lastErrorId = "0-0".
const INITIAL_LAST_ERROR_ID = '0-0';
// The Elect function's own `initialize` block sets global.set('cleaning-needed', true) --
// fail-safe default until the first election poll actually reports the cluster's S3 state.
const INITIAL_CLEANING_NEEDED = true;

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCleaner(
	config: Config,
	debug: DebugController,
	log: typeof console,
	signal: AbortSignal,
	processUuid: string,
	logSink?: LogSink,
	gate?: LevelGate,
): Promise<void> {
	const queue = config.global.queue;
	if (!queue) throw new Error('runCleaner called without global.queue (validation should have caught this)');
	const worker = config.global.worker;

	const isDebugEnabled = () => debug.has('CLEANER');

	// "Process Errors" (previous-node fbb02586af0f3189, Debug) and "Clean
	// Redis" (previous-node 16843fc39d8d2908, Debug) -- see the Poll
	// Errors / Clean Redis GC loops below. undefined (not built) when
	// this runner is called without a logSink/gate.
	const processErrorsLog = logSink && gate ? createSourceLogger('Process Errors', logSink, gate, 'CLEANER') : undefined;
	const cleanRedisLog = logSink && gate ? createSourceLogger('Clean Redis', logSink, gate, 'CLEANER') : undefined;

	const commandConn = createRedisConnection(config.global.redis);
	const store = new IoredisCleanerStore(commandConn);
	const gcStore = new IoredisGcStore(commandConn);
	const electionStore = new IoredisElectionStore(commandConn);

	// Dedicated psubscribe connection -- see header note.
	const subConn = createRedisConnection(config.global.redis);

	// This replica's OWN downloader config, per the Schedule function's literal
	// `global.get('rename-to-s3')` read -- Node-RED's global context is
	// process-local, so this reflects THIS replica's config file, NOT
	// necessarily the config of whichever replica actually did the download
	// (the "<worker>" the cleaner-reporter message names may be a different
	// replica entirely, in a multi-worker deployment). Ported exactly as
	// coded, not "fixed" into a per-message lookup that flows.json never did.
	const scheduleConfig: ScheduleConfig = {
		renameToS3: config.downloader?.['rename-to'] === 's3',
		keepInCacheSeconds: config.cleaner?.['keep-in-cache'],
		downloadsMarker: computeDownloadsMarker(config.downloader?.['aria-download']),
	};

	const gcThresholdSeconds = config.cleaner?.['redis-gc-threshold-seconds'] ?? GC_DEFAULT_THRESHOLD_SECONDS;

	const state = { primary: false, cleaningNeeded: INITIAL_CLEANING_NEEDED };
	let lastErrorId = INITIAL_LAST_ERROR_ID;

	// -- Election --
	const electionLoop = runElectionLoop(
		{
			store: electionStore,
			role: 'cleaner',
			uuid: processUuid,
			onResult: (priority, workers) => {
				state.primary = priority === 'primary';
				state.cleaningNeeded = computeCleaningNeeded(workers, Date.now());
				if (isDebugEnabled()) log.log(`CLEANER: election -> ${priority}, cleaning-needed=${state.cleaningNeeded}`);
			},
			warn: (m) => log.warn(`CLEANER: ${m}`),
		},
		signal,
		defaultSleep,
	);

	// -- Schedule (event-driven off psubscribe) --
	const scheduleChannel = cleanerReporterKey('*'); // "wis2gc:cleaner-reporter:*" -- pattern, not a literal worker.
	subConn.on('pmessage', (_pattern: string, channel: string, message: string) => {
		if (!state.primary || !state.cleaningNeeded) return;
		void (async () => {
			try {
				let flat: unknown[];
				try {
					const parsed: unknown = JSON.parse(message);
					flat = Array.isArray(parsed) ? parsed : [];
				} catch {
					flat = [];
				}
				const result = decideSchedule(scheduleConfig, flat, channel, Date.now());
				if (!result) return;
				await store.scheduleCleanup(result.scoreMs, result.member);
			} catch (err) {
				log.error(`CLEANER: Schedule failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		})();
	});
	await subConn.psubscribe(scheduleChannel);

	// -- Sweep --
	const sweepJobs: SweepJob[] = [
		{ zsetKey: cleanerPendingKey(), action: 'delete', field: 'filename' },
		{ zsetKey: cleanerCancelKey(), action: 'cancel', field: 'aria2_gid' },
	];
	const sweepLoop = (async () => {
		await defaultSleep(SWEEP_ONCE_DELAY_S * 1000);
		while (!signal.aborted) {
			if (state.primary && state.cleaningNeeded) {
				for (const job of sweepJobs) {
					try {
						const due = await store.dueSweepMembers(job.zsetKey, Date.now());
						if (due.length === 0) continue;
						const plan = planSweepJob(job, due);
						for (const xadd of plan.xadds) {
							await store.enqueueWorkerCommand(xadd.worker, xadd.action, xadd.field, xadd.value);
						}
						if (plan.zremMembers.length > 0) await store.removeSweepMembers(job.zsetKey, plan.zremMembers);
					} catch (err) {
						log.error(`CLEANER: Sweep failed for ${job.zsetKey}: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
			await defaultSleep(SWEEP_INTERVAL_S * 1000);
		}
	})();

	// -- Poll Errors --
	const pollErrorsLoop = (async () => {
		await defaultSleep(POLL_ERRORS_ONCE_DELAY_MS);
		while (!signal.aborted) {
			if (state.primary) {
				try {
					const reply = await store.readErrorStream(queue, worker, lastErrorId);
					if (reply) {
						const result = processErrors(reply as XreadReply);
						if (result.lastErrorId) lastErrorId = result.lastErrorId;
						for (const m of result.messages) {
							if (isDebugEnabled()) log.log(`CLEANER: error ${m.entryId}: ${JSON.stringify(m.payload)}`);
							processErrorsLog?.debug({ entryId: m.entryId, payload: m.payload });
						}
					}
				} catch (err) {
					log.error(`CLEANER: Poll Errors failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			await defaultSleep(POLL_ERRORS_INTERVAL_MS);
		}
	})();

	// -- Clean Redis GC --
	const gcLoop = (async () => {
		await defaultSleep(GC_ONCE_DELAY_MS);
		while (!signal.aborted) {
			if (state.primary) {
				try {
					const stats = await runGcSweep(gcStore, gcThresholdSeconds, (m) => log.warn(`CLEANER: ${m}`));
					if (isDebugEnabled() || stats.totalDeleted > 0) log.log(`CLEANER: Clean Redis deleted ${stats.totalDeleted} keys (errors=${stats.errors})`);
					cleanRedisLog?.debug({ totalDeleted: stats.totalDeleted, errors: stats.errors });
				} catch (err) {
					log.error(`CLEANER: Clean Redis failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			await defaultSleep(GC_INTERVAL_MS);
		}
	})();

	log.log('CLEANER: election + schedule + sweep + poll-errors + clean-redis loops starting');
	await Promise.allSettled([electionLoop, sweepLoop, pollErrorsLoop, gcLoop]);
	log.log('CLEANER: shutdown signalled, closing connections');

	await subConn.punsubscribe(scheduleChannel);
	await subConn.quit();
	await store.quit();
}
