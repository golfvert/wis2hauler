#!/usr/bin/env bun
// Process entrypoint. Usage:
//
//   bun src/main.ts <config.yaml> [-d role[,role...]]...
//
// The config file path is a required positional argument (per
// the maintainer's "the configuration file should be given as a parameter"
// decision) — there's no default path, unlike antiloop's fixed
// "./common.env"+"./<centre_id>.env" convention, since this project's
// config is one YAML file, not a pair of env files.
//
// -d works like antiloop's: repeatable and/or comma-separated,
// setting the static debug baseline (see debug.ts). Granularity is
// ROLES (SUBSCRIBER/DOWNLOADER/CLEANER/REPORTER/REPLAYER) plus the
// "ALL" shorthand — not free-form category strings — so a typo is a
// hard CLI usage error (exit 2) rather than a silently-ignored no-op.
//
// DELIBERATE CHANGE, 2026-09-12: there used to also be a live-
// reloadable --debug-file, polled on a timer, for changing debug
// categories without a restart. the maintainer had it removed outright ("No
// need to read a debug file. Everything is /get /set, and nothing
// else."): that's now GET /get?key=debug / POST /set {"debug":[...]}
// instead (../admin/get.ts, ../admin/set.ts, ../config/runtime.ts),
// the exact same channel every other piece of live-mutable state
// already goes through. -d itself is untouched — it's a startup-only
// baseline, not a second live-mutation path, so it doesn't compete
// with /get /set the way the file did.
//
// Which role(s) this process actually runs comes from the config
// file's global.roles, not a CLI flag — matches how the system is
// already run today (see the project's architecture notes, "Process
// topology").
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ConfigError, loadConfig } from './config/load.ts';
import { DebugController, DEBUG_CATEGORIES, type DebugCategory } from './debug.ts';
import { VALID_ROLES, type Role, type Config, type BrokerConfig } from './config/schema.ts';
import { runSubscriber } from './subscriber/run.ts';
import { runDownloader } from './downloader/run.ts';
import { runCleaner } from './cleaner/run.ts';
import { runReporter } from './reporter/run.ts';
import { runReplayer } from './replayer/run.ts';
import { runHeartbeat } from './election/run.ts';
import { connectMqtt, connectMqttBestEffort } from './mqtt/client.ts';
import type { MqttLike } from './mqtt/types.ts';
import { createHttpServer, type HttpRouter } from './http/router.ts';
import { RuntimeConfigStore } from './admin/runtime-store.ts';
import { registerAdminRoutes } from './admin/routes.ts';
import { createRedisConnection, type RedisConnection } from './redis/ioredis-store.ts';
import { IoredisDownloaderStore } from './redis/ioredis-downloader-store.ts';
import type { DownloaderStore } from './downloader/store.ts';
import { createLogSinkFromConfig } from './logging/from-config.ts';
import { createSourceLogger, type LevelGate } from './logging/logger.ts';
import { WinstonLogSink, type LogSink } from './logging/sink.ts';

export interface Cli {
	configPath: string;
	debugCategories: DebugCategory[];
}

export class CliUsageError extends Error {}

// One long-running role runner per role — SUBSCRIBER (subscriber/run.ts),
// DOWNLOADER (downloader/run.ts), CLEANER (cleaner/run.ts), REPORTER
// (reporter/run.ts), REPLAYER (replayer/run.ts) — plus `heartbeat`,
// which isn't a config-file role at all: it's the Setup tab's
// unconditional heartbeat loop (see election/run.ts's header), started
// alongside whichever roles ARE active regardless of what they are.
// REPORTER and REPLAYER both register routes on one shared HTTP router
// (../http/router.ts) rather than each opening their own Bun.serve() --
// main() now creates that router UNCONDITIONALLY (see the removed
// needsHttp gate below): the Setup tab's admin API (GET /get, POST
// /set -- ../admin/routes.ts) is reachable regardless of which roles a
// replica runs, matching the original (Node-RED's admin server was
// never role-gated either). REPLAYER's runner additionally takes the
// shared RuntimeConfigStore (../admin/runtime-store.ts) -- the SAME
// instance the admin routes read/write, since POST /replayer's
// 'global-replay' field writes through it too (see replayer/run.ts's
// header).
// Injectable so tests can swap in fakes that resolve immediately
// instead of opening real MQTT/Redis/aria2/HTTP connections;
// defaultRunners is what the real CLI uses.
export interface RoleRunners {
	// logSink/gate: the module-logger's write destination (../logging/
	// sink.ts, built from global.log -- ../logging/from-config.ts) and
	// level gate (the same RuntimeConfigStore instance the admin API
	// reads/writes -- it implements ../logging/logger.ts's LevelGate).
	// Optional, trailing, and only added to the three role runners that
	// actually have ported logIO call sites (see each runner's own
	// header) -- reporter/replayer/heartbeat have none (confirmed via
	// the flows.json previous-node trace, session notes). Optional so
	// every existing fake in main.test.ts (which only supplies 4 or 5
	// positional args) keeps compiling unchanged.
	// upstreamClients/publishClients: already-connected GB1/GB2 and
	// PUB1/PUB2 clients -- main() is the orchestrator now (the maintainer:
	// "main.ts being the 'orchestrator' should manage all connection
	// for both up and down"), so these runners no longer open or close
	// any MQTT connection themselves; they only subscribe/publish/wire
	// handlers on what they're handed. See connectMqtt/connectMqttBestEffort
	// below for who actually opens these.
	subscriber: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, upstreamClients: MqttLike[], publishClients: MqttLike[], logSink?: LogSink, gate?: LevelGate) => Promise<void>;
	downloader: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, publishClients: MqttLike[], logSink?: LogSink, gate?: LevelGate) => Promise<void>;
	cleaner: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string, logSink?: LogSink, gate?: LevelGate) => Promise<void>;
	reporter: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string, router: HttpRouter) => Promise<void>;
	replayer: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string, router: HttpRouter, runtimeStore: RuntimeConfigStore) => Promise<void>;
	heartbeat: (config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string) => Promise<void>;
	// The orchestrator's own MQTT connection primitives (../mqtt/
	// client.ts) -- REQUIRED (not optional-with-a-real-default) so a
	// test can't forget to fake one and accidentally dial a real
	// broker: every RoleRunners literal, real or fake, must say
	// explicitly how a connection gets made. defaultRunners below
	// supplies the real mqtt.js-backed implementations; tests supply
	// stubs returning an in-memory MqttLike (see main.test.ts).
	connectMqtt: (broker: BrokerConfig, label: string, clientId: string) => Promise<MqttLike>;
	connectMqttBestEffort: (broker: BrokerConfig, label: string, clientId: string, log: Pick<typeof console, 'error'>, initialTimeoutMs?: number) => Promise<MqttLike>;
}

export const defaultRunners: RoleRunners = {
	subscriber: runSubscriber,
	downloader: runDownloader,
	cleaner: runCleaner,
	reporter: runReporter,
	replayer: runReplayer,
	heartbeat: runHeartbeat,
	connectMqtt,
	connectMqttBestEffort,
};

// Matches reporter/run.ts's and replayer/run.ts's routes not being in
// flows.json at all (Node-RED's http-in nodes bind to Node-RED's own
// admin server, settings.js's uiPort) — per the maintainer's explicit decision
// this session ("nodered offers one port... for all HTTP access. So,
// [one shared Bun.serve] will behave the same."), documented alongside
// global['http-port'] in config/schema.ts.
//
// DELIBERATE CHANGE, 2026-09-12: this used to default to 0 (OS-
// assigned), on the theory that a Traefik dynamic-config registration
// step (this session, since removed -- see schema.ts's GlobalSection
// doc comment) would always announce whichever port the OS actually
// handed out. Now that this app never self-registers with anything,
// an OS-assigned port with nothing announcing it would be silently
// unreachable -- exactly the regression the maintainer would have hit deploying
// without Traefik. A fixed, known default closes that gap; 8080
// matches what schema.ts's own `http-port` doc comment already
// (mistakenly, before this fix) claimed the behavior was. Set
// `global.http-port` explicitly for a real deployment, same as
// aria2's own RPC port -- this default is only a fallback.
const DEFAULT_HTTP_PORT = 8080;

function parseDebugCategory(raw: string): DebugCategory {
	const normalized = raw.trim().toUpperCase();
	if (!DEBUG_CATEGORIES.has(normalized)) {
		throw new CliUsageError(
			`unknown -d value '${raw}' — expected one of: ${[...VALID_ROLES].join(', ')}, ALL`,
		);
	}
	return normalized as DebugCategory;
}

export function parseCli(argv: string[]): Cli {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			debug: { type: 'string', short: 'd', multiple: true },
		},
		allowPositionals: true,
	});

	const configPath = positionals[0];
	if (!configPath) {
		throw new CliUsageError('usage: bun src/main.ts <config.yaml> [-d role[,role...]]...');
	}

	const debugCategories = (values.debug ?? []).flatMap((v) =>
		v.split(',').map((s) => s.trim()).filter((s) => s.length > 0).map(parseDebugCategory),
	);

	return { configPath, debugCategories };
}

// Returns the process exit code rather than calling process.exit
// itself, so this is testable without actually terminating the test
// runner — see the bottom of this file for the real CLI entrypoint.
export async function main(
	argv: string[],
	log: typeof console = console,
	runners: RoleRunners = defaultRunners,
	signal: AbortSignal = new AbortController().signal,
): Promise<number> {
	let cli: Cli;
	try {
		cli = parseCli(argv);
	} catch (err) {
		if (err instanceof CliUsageError) {
			log.error(err.message);
			return 2;
		}
		throw err;
	}

	const debug = new DebugController({ staticCategories: cli.debugCategories });

	let loaded: ReturnType<typeof loadConfig>;
	try {
		loaded = loadConfig(cli.configPath);
	} catch (err) {
		if (err instanceof ConfigError) {
			log.error(`config invalid: ${cli.configPath}`);
			for (const e of err.result.errors) log.error(`  error: ${e}`);
			for (const w of err.result.warnings) log.error(`  warning: ${w}`);
			// "Invalid" (Setup tab, previous-node 2e47c9209c1d68f7's
			// validator-fail branch, Info level): the config never loaded,
			// so there's no global.log to build the real sink from yet --
			// an ephemeral stdout-only sink is used just for this one call,
			// matching the original's own logger nodes being statically
			// configured, not driven by the YAML under validation.
			createSourceLogger('Invalid', new WinstonLogSink({ destination: 'stdout' }), { effectiveLevel: () => 'info' }).info({
				path: cli.configPath,
				errors: err.result.errors.length,
				warnings: err.result.warnings.length,
			});
			return 1;
		}
		throw err;
	}

	const { config, result } = loaded;
	for (const w of result.warnings) log.warn(`config warning: ${w}`);
	// Config infos print unconditionally now — 'config' was never a
	// real role, so there's no role-shaped gate for it any more. The
	// per-role debug toggle now only governs each role's own runtime
	// logging once that role's live implementation lands.
	for (const i of result.infos) log.log(`config: ${i}`);

	const roles = config.global.roles.split(',').map((r) => r.trim()) as Role[];
	log.log(`wis2hauler starting: worker=${config.global.worker} roles=${roles.join(', ')}`);

	// Per-process, in-memory Setup-tab state (process-mode/log-level/
	// per-role log-level overrides/whitelist/blacklist/overridelist/
	// global-replay) -- see ../admin/runtime-store.ts's header for why
	// this is deliberately per-process, not shared across replicas.
	// Constructed here (moved up from further below) since it doubles as
	// every module logger's ../logging/logger.ts LevelGate from this
	// point on.
	const runtimeStore = new RuntimeConfigStore(config);

	// The module-logger's write destination, built once from global.log
	// (../logging/from-config.ts closes the config->sink gap) and shared
	// by every createSourceLogger call below and in the role runners
	// this process starts.
	const logSink = createLogSinkFromConfig(config.global.log);

	// "Config" (previous-node 1973f1c302d2301a, off the yaml-parsing
	// node, Info) and "Valid" (previous-node 2e47c9209c1d68f7's
	// validator-ok branch, Info) -- both role-agnostic Setup/admin infra,
	// so no role is passed (see logger.ts's createSourceLogger doc).
	createSourceLogger('Config', logSink, runtimeStore).info({ path: cli.configPath, worker: config.global.worker, roles: config.global.roles });
	createSourceLogger('Valid', logSink, runtimeStore).info({ path: cli.configPath, warnings: result.warnings.length });

	const processUuid = randomUUID();
	const activeRoles = new Set<Role>(roles);

	// One shared HTTP server per process, ALWAYS — reversing the earlier
	// REPORTER/REPLAYER-only gate (see the project notes' "Step 7"
	// section for that original decision). The Setup tab's admin API
	// (GET /get, POST /set — ../admin/routes.ts) is reachable on every
	// replica regardless of active roles in the original (Node-RED's
	// admin server was never role-gated), so this now matches that.
	const httpHandle = createHttpServer(config.global['http-port'] ?? DEFAULT_HTTP_PORT);
	// Always logged, regardless of deployment shape -- this app has no
	// self-registration step to fall back on for surfacing this (see
	// DEFAULT_HTTP_PORT's doc comment above), so this line is now the
	// only place the bound port is reported at all.
	log.log(`wis2hauler: HTTP admin server listening on port ${httpHandle.port} (worker=${config.global.worker})`);

	// The admin API's 'credentials' field (GET /get?key=credentials,
	// POST /set's credentials CRUD) needs its own Redis connection —
	// DOWNLOADER's own store (downloader/run.ts) is entirely internal to
	// that role's runner, not something main() has a handle on. Only
	// opened when DOWNLOADER is active, matching every other role's own
	// connect-only-if-active pattern (reporter/run.ts, replayer/run.ts).
	let credentialsConn: RedisConnection | null = null;
	let credentialsStore: DownloaderStore | null = null;
	if (roles.includes('DOWNLOADER')) {
		credentialsConn = createRedisConnection(config.global.redis);
		credentialsStore = new IoredisDownloaderStore(credentialsConn);
	}

	// PUB1/PUB2 (global.local-broker) -- shared across SUBSCRIBER and
	// DOWNLOADER when both are active on this replica. Previously each
	// role opened its own independent connection to the very same
	// broker, which was both wasted (two sockets for one outcome) and
	// the root of a real client-id collision risk (see mqtt/client.ts's
	// connectMqtt doc comment): the MQTT spec has a broker disconnect
	// whichever connection already held a given client-id the moment a
	// second one presents it. main() is the orchestrator now (the maintainer:
	// "main.ts being the 'orchestrator' should manage all connection
	// for both up and down"), so it owns opening these once and handing
	// the same client instances to whichever of SUBSCRIBER/DOWNLOADER
	// are active, and closing them once after every role has settled
	// (below, alongside credentialsConn.quit()). connectMqttBestEffort
	// is guaranteed to always resolve, never reject (see its own doc
	// comment), so this is safe to do here, eagerly, before any
	// role-promise's own try/catch even starts.
	const mqttClientIdBase = `${config.global['centre-id'] ?? ''}-${config.global.worker}`;
	const publishClients: MqttLike[] = [];
	if (roles.includes('SUBSCRIBER') || roles.includes('DOWNLOADER')) {
		const localBrokers = config.global['local-broker'] ?? [];
		for (let i = 0; i < localBrokers.length; i++) {
			const label = `PUB${i + 1}`;
			log.log(`orchestrator: connecting to ${label} (${localBrokers[i]!.broker})`);
			const client = await runners.connectMqttBestEffort(localBrokers[i]!, label, `${mqttClientIdBase}-${label}`, log);
			publishClients.push(client);
		}
	}

	registerAdminRoutes(httpHandle.router, {
		config,
		store: runtimeStore,
		activeRoles,
		credentialsStore,
		debug,
		log,
		// "Change ?" (Setup tab, previous-node eeca55e8996b39fc, Info) --
		// see ../admin/routes.ts's POST /set handler, which logs one Info
		// call per changed key.
		changeLogger: createSourceLogger('Change ?', logSink, runtimeStore),
	});

	// All active roles run CONCURRENTLY, alongside the always-on
	// heartbeat — per the maintainer's explicit "Fix it now: run all active roles
	// concurrently" decision this session. This replaces what used to be
	// a sequential chain of `if (roles.includes(...)) { await ... }`:
	// each of those blocked on the previous one's signal-triggered
	// shutdown before the next ever started, so a replica actually
	// combining two live roles would only ever run the first one listed
	// here. Promise.allSettled (not Promise.all) so one role's crash
	// doesn't hide how the others actually finished.
	//
	// Each role is wrapped in its own try/catch that logs+rethrows
	// IMMEDIATELY on failure, rather than relying solely on the
	// post-Promise.allSettled loop below to report it. Found live
	// (the maintainer: SUBSCRIBER/DOWNLOADER went silent right after connecting
	// to the upstream brokers, no error, no further log lines, nothing
	// -- turned out to be exactly this): Promise.allSettled(rolePromises)
	// only resolves once EVERY entry has settled, including the
	// always-on heartbeat and every other elected-role loop (Cleaner/
	// Reporter/Replayer), which run forever and only settle on
	// SIGINT/SIGTERM. So a role that throws immediately (e.g. a
	// PUB1/PUB2 mqtt.connect() rejecting because the broker hostname
	// doesn't resolve) used to fail completely silently -- the crash
	// was real and immediate, but nothing said so until the whole
	// process was killed and the original post-allSettled reporting
	// loop finally ran. Logging it the moment it happens fixes that
	// without changing the exit-code logic below, which still needs the
	// full settled array.
	const rolePromises: Promise<void>[] = [];

	rolePromises.push(
		(async () => {
			try {
				await runners.heartbeat(config, debug, log, signal, processUuid);
			} catch (err) {
				log.error(`HEARTBEAT failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
				throw err;
			}
		})(),
	);

	if (roles.includes('DOWNLOADER')) {
		rolePromises.push(
			(async () => {
				log.log('DOWNLOADER role starting.');
				try {
					await runners.downloader(config, debug, log, signal, publishClients, logSink, runtimeStore);
					log.log('DOWNLOADER role stopped.');
				} catch (err) {
					log.error(`DOWNLOADER role failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
					throw err;
				}
			})(),
		);
	}
	if (roles.includes('CLEANER')) {
		rolePromises.push(
			(async () => {
				log.log('CLEANER role starting.');
				try {
					await runners.cleaner(config, debug, log, signal, processUuid, logSink, runtimeStore);
					log.log('CLEANER role stopped.');
				} catch (err) {
					log.error(`CLEANER role failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
					throw err;
				}
			})(),
		);
	}
	if (roles.includes('REPORTER')) {
		rolePromises.push(
			(async () => {
				log.log('REPORTER role starting.');
				try {
					await runners.reporter(config, debug, log, signal, processUuid, httpHandle.router);
					log.log('REPORTER role stopped.');
				} catch (err) {
					log.error(`REPORTER role failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
					throw err;
				}
			})(),
		);
	}
	if (roles.includes('REPLAYER')) {
		rolePromises.push(
			(async () => {
				log.log('REPLAYER role starting.');
				try {
					await runners.replayer(config, debug, log, signal, processUuid, httpHandle.router, runtimeStore);
					log.log('REPLAYER role stopped.');
				} catch (err) {
					log.error(`REPLAYER role failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
					throw err;
				}
			})(),
		);
	}
	if (roles.includes('SUBSCRIBER')) {
		rolePromises.push(
			(async () => {
				log.log('SUBSCRIBER role starting.');
				const upstreamClients: MqttLike[] = [];
				try {
					// GB1/GB2 -- connected here, inside SUBSCRIBER's own
					// try/catch, on purpose: connectMqtt CAN reject (an
					// unresolvable broker hostname, an auth failure), and
					// that must only fail the SUBSCRIBER role-promise, same
					// as every other failure this role can have -- not the
					// whole process and not any other role (see this
					// function's own header comment on why every role gets
					// its own try/catch, found live from exactly this class
					// of failure).
					const sub = config.subscriber;
					if (!sub) throw new Error('SUBSCRIBER role active without a subscriber: config section (validation should have caught this)');
					for (let i = 0; i < sub['global-broker'].length; i++) {
						const label = `GB${i + 1}`;
						const broker = sub['global-broker'][i]!;
						log.log(`orchestrator: connecting to ${label} (${broker.broker})`);
						const client = await runners.connectMqtt(broker, label, `${mqttClientIdBase}-${label}`);
						upstreamClients.push(client);
					}
					await runners.subscriber(config, debug, log, signal, upstreamClients, publishClients, logSink, runtimeStore);
					log.log('SUBSCRIBER role stopped.');
				} catch (err) {
					log.error(`SUBSCRIBER role failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
					throw err;
				} finally {
					await Promise.allSettled(upstreamClients.map((c) => c.end()));
				}
			})(),
		);
	}

	const settled = await Promise.allSettled(rolePromises);

	httpHandle.stop();
	await Promise.allSettled(publishClients.map((c) => c.end()));
	if (credentialsConn) await credentialsConn.quit();

	// Already logged immediately, per-role, above -- this just decides
	// the exit code from the same settled results.
	const anyFailed = settled.some((outcome) => outcome.status === 'rejected');

	return anyFailed ? 1 : 0;
}

// Bounded grace period between SIGINT/SIGTERM and a hard process.exit,
// in case some connection's own teardown (a Redis Cluster .quit(), an
// aria2 WebSocket, an mqtt.js client mid-reconnect, ...) hangs despite
// every role's own best-effort cleanup -- see mqtt/client.ts's end()
// for one concrete case of this that was found and fixed directly (a
// well-known mqtt.js gotcha), but this timeout exists as a backstop
// for whichever one wasn't. Without it, a single hung teardown call
// anywhere in the shutdown chain means Ctrl-C does nothing at all and
// the process can only be killed with SIGKILL -- exactly what the maintainer
// hit before mqtt/client.ts's own fix.
const SHUTDOWN_GRACE_MS = 10000;

if (import.meta.main) {
	const shutdown = new AbortController();
	let shuttingDown = false;
	const onSignal = () => {
		if (shuttingDown) return; // second Ctrl-C while already shutting down: no-op, let the grace timer do its job
		shuttingDown = true;
		shutdown.abort();
		setTimeout(() => {
			console.error(`shutdown did not complete within ${SHUTDOWN_GRACE_MS}ms -- forcing exit`);
			process.exit(1);
		}, SHUTDOWN_GRACE_MS).unref();
	};
	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	main(process.argv.slice(2), console, defaultRunners, shutdown.signal).then(
		(code) => process.exit(code),
		(err) => {
			console.error(err instanceof Error ? err.stack ?? err.message : err);
			process.exit(1);
		},
	);
}
