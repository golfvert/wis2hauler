import { describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { parseCli, CliUsageError, main, type RoleRunners } from '../main.ts';
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import type { HttpRouter } from '../http/router.ts';
import type { RuntimeConfigStore } from '../admin/runtime-store.ts';
import type { MqttLike } from '../mqtt/types.ts';

const validConfig = fileURLToPath(new URL('../../fixtures/example.valid.yaml', import.meta.url));
const invalidConfig = fileURLToPath(new URL('../../fixtures/example.invalid.yaml', import.meta.url));
const cleanerOnlyConfig = fileURLToPath(new URL('../../fixtures/example.cleaner-only.yaml', import.meta.url));

function fakeLog() {
	const lines = { log: [] as string[], warn: [] as string[], error: [] as string[] };
	const log = {
		log: (...args: unknown[]) => lines.log.push(args.join(' ')),
		warn: (...args: unknown[]) => lines.warn.push(args.join(' ')),
		error: (...args: unknown[]) => lines.error.push(args.join(' ')),
	} as unknown as typeof console;
	return { log, lines };
}

// A fake MqttLike -- backs every fake connectMqtt/connectMqttBestEffort
// below, so no test ever dials a real broker (main.ts's orchestrator
// now opens every MQTT connection itself -- see its RoleRunners doc
// comment on connectMqtt/connectMqttBestEffort being REQUIRED fields
// for exactly this reason).
function fakeMqttLike(): MqttLike {
	return {
		subscribe: async () => {},
		onMessage: () => {},
		publish: async () => {},
		end: async () => {},
	};
}

// A fake RoleRunners for tests: real MQTT/Redis/aria2/HTTP wiring
// (subscriber/run.ts, downloader/run.ts, cleaner/run.ts, reporter/
// run.ts, replayer/run.ts, election/run.ts) needs live infrastructure
// this test suite doesn't have, so the injected fakes just record that
// they were called and resolve immediately, instead of actually
// connecting to anything. connectMqtt/connectMqttBestEffort are faked
// the same way, via fakeMqttLike() above -- see main.ts's RoleRunners
// doc comment. (The shared HTTP server itself is NOT injectable -- see
// the fixture's 'http-port: 18723' -- so REPORTER/REPLAYER tests below
// do bind a real, empty Bun.serve() for the duration of the main()
// call.)
function fakeRunners() {
	const subscriberCalls: { config: Config; debug: DebugController; signal: AbortSignal }[] = [];
	const downloaderCalls: { config: Config; debug: DebugController; signal: AbortSignal }[] = [];
	const cleanerCalls: { config: Config; debug: DebugController; signal: AbortSignal; processUuid: string }[] = [];
	const reporterCalls: { config: Config; debug: DebugController; signal: AbortSignal; processUuid: string; router: HttpRouter }[] = [];
	const replayerCalls: { config: Config; debug: DebugController; signal: AbortSignal; processUuid: string; router: HttpRouter; runtimeStore: RuntimeConfigStore }[] = [];
	const heartbeatCalls: { config: Config; debug: DebugController; signal: AbortSignal; processUuid: string }[] = [];
	const runners: RoleRunners = {
		subscriber: async (config, debug, _log, signal) => {
			subscriberCalls.push({ config, debug, signal });
		},
		downloader: async (config, debug, _log, signal) => {
			downloaderCalls.push({ config, debug, signal });
		},
		cleaner: async (config, debug, _log, signal, processUuid) => {
			cleanerCalls.push({ config, debug, signal, processUuid });
		},
		reporter: async (config, debug, _log, signal, processUuid, router) => {
			reporterCalls.push({ config, debug, signal, processUuid, router });
		},
		replayer: async (config, debug, _log, signal, processUuid, router, runtimeStore) => {
			replayerCalls.push({ config, debug, signal, processUuid, router, runtimeStore });
		},
		heartbeat: async (config, debug, _log, signal, processUuid) => {
			heartbeatCalls.push({ config, debug, signal, processUuid });
		},
		connectMqtt: async () => fakeMqttLike(),
		connectMqttBestEffort: async () => fakeMqttLike(),
	};
	return { runners, subscriberCalls, downloaderCalls, cleanerCalls, reporterCalls, replayerCalls, heartbeatCalls };
}

describe('parseCli', () => {
	test('requires a config path positional', () => {
		expect(() => parseCli([])).toThrow(CliUsageError);
	});

	test('takes the config path as the first positional', () => {
		const cli = parseCli(['config.yaml']);
		expect(cli.configPath).toBe('config.yaml');
	});
});

describe('main', () => {
	test('exits 2 with usage on no config path', async () => {
		const { log, lines } = fakeLog();
		const code = await main([], log);
		expect(code).toBe(2);
		expect(lines.error[0]).toMatch(/usage:/);
	});

	test('exits 1 and reports errors for an invalid config', async () => {
		const { log, lines } = fakeLog();
		const code = await main([invalidConfig], log);
		expect(code).toBe(1);
		expect(lines.error[0]).toMatch(/config invalid/);
		expect(lines.error.some((l) => l.includes('global.worker'))).toBe(true);
	});

	test('exits 0, reports roles, and starts every active role plus the heartbeat via the injected runners', async () => {
		const { log, lines } = fakeLog();
		const { runners, subscriberCalls, downloaderCalls, cleanerCalls, reporterCalls, replayerCalls, heartbeatCalls } = fakeRunners();
		const code = await main([validConfig], log, runners);
		expect(code).toBe(0);
		expect(lines.log.some((l) => l.includes('roles=SUBSCRIBER, DOWNLOADER, CLEANER, REPORTER, REPLAYER'))).toBe(true);
		expect(lines.log.some((l) => l.includes('SUBSCRIBER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('SUBSCRIBER role stopped'))).toBe(true);
		expect(lines.log.some((l) => l.includes('DOWNLOADER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('DOWNLOADER role stopped'))).toBe(true);
		expect(lines.log.some((l) => l.includes('CLEANER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('CLEANER role stopped'))).toBe(true);
		expect(lines.log.some((l) => l.includes('REPORTER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('REPORTER role stopped'))).toBe(true);
		expect(lines.log.some((l) => l.includes('REPLAYER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('REPLAYER role stopped'))).toBe(true);
		expect(lines.warn).toEqual([]); // the valid fixture has no warnings
		expect(subscriberCalls).toHaveLength(1);
		expect(subscriberCalls[0]!.config.global.worker).toBe('wis2hauler-01');
		expect(downloaderCalls).toHaveLength(1);
		expect(downloaderCalls[0]!.config.global.worker).toBe('wis2hauler-01');
		expect(cleanerCalls).toHaveLength(1);
		expect(reporterCalls).toHaveLength(1);
		expect(replayerCalls).toHaveLength(1);
		// The heartbeat is unconditional (Setup tab's "Ready ?" gate has no
		// role condition), so it runs even though it isn't itself a role.
		expect(heartbeatCalls).toHaveLength(1);
	});

	test('cleaner/reporter/replayer/heartbeat all receive the same processUuid, generated once', async () => {
		const { log } = fakeLog();
		const { runners, cleanerCalls, reporterCalls, replayerCalls, heartbeatCalls } = fakeRunners();
		await main([validConfig], log, runners);
		const uuid = cleanerCalls[0]!.processUuid;
		expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
		expect(reporterCalls[0]!.processUuid).toBe(uuid);
		expect(replayerCalls[0]!.processUuid).toBe(uuid);
		expect(heartbeatCalls[0]!.processUuid).toBe(uuid);
	});

	test('reporter and replayer are handed the same shared HTTP router', async () => {
		const { log } = fakeLog();
		const { runners, reporterCalls, replayerCalls } = fakeRunners();
		await main([validConfig], log, runners);
		expect(reporterCalls[0]!.router).toBe(replayerCalls[0]!.router);
	});

	test('config infos are printed unconditionally, on every run', async () => {
		const { log, lines } = fakeLog();
		const { runners } = fakeRunners();
		await main([validConfig], log, runners);
		expect(lines.log.some((l) => l.startsWith('config: '))).toBe(true);
	});

	test('active roles run concurrently, not sequentially: a slow DOWNLOADER does not block CLEANER from starting and finishing', async () => {
		const { log, lines } = fakeLog();
		let releaseDownloader: () => void = () => {};
		const runners: RoleRunners = {
			subscriber: async () => {},
			downloader: async () => {
				await new Promise<void>((resolve) => {
					releaseDownloader = resolve;
				});
			},
			cleaner: async () => {},
			reporter: async () => {},
			replayer: async () => {},
			heartbeat: async () => {},
			connectMqtt: async () => fakeMqttLike(),
			connectMqttBestEffort: async () => fakeMqttLike(),
		};

		const donePromise = main([validConfig], log, runners);

		// Let every already-resolved fake's continuation run (microtasks
		// drain before a macrotask fires), while DOWNLOADER's fake is still
		// blocked on releaseDownloader.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(lines.log.some((l) => l.includes('DOWNLOADER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('CLEANER role starting'))).toBe(true);
		expect(lines.log.some((l) => l.includes('CLEANER role stopped'))).toBe(true);
		// DOWNLOADER hasn't stopped yet -- proves CLEANER didn't wait for it
		// the way the old sequential `if (...) { await ... }` chain would
		// have required.
		expect(lines.log.some((l) => l.includes('DOWNLOADER role stopped'))).toBe(false);

		releaseDownloader();
		const code = await donePromise;
		expect(code).toBe(0);
		expect(lines.log.some((l) => l.includes('DOWNLOADER role stopped'))).toBe(true);
	});

	test('one role rejecting is reported and surfaces as exit code 1, without preventing the others from completing', async () => {
		const { log, lines } = fakeLog();
		const runners: RoleRunners = {
			subscriber: async () => {},
			downloader: async () => {
				throw new Error('boom');
			},
			cleaner: async () => {},
			reporter: async () => {},
			replayer: async () => {},
			heartbeat: async () => {},
			connectMqtt: async () => fakeMqttLike(),
			connectMqttBestEffort: async () => fakeMqttLike(),
		};
		const code = await main([validConfig], log, runners);
		expect(code).toBe(1);
		expect(lines.error.some((l) => l.includes('boom'))).toBe(true);
		// Every other role still started and stopped normally.
		expect(lines.log.some((l) => l.includes('CLEANER role stopped'))).toBe(true);
		expect(lines.log.some((l) => l.includes('SUBSCRIBER role stopped'))).toBe(true);
	});

	test('replayer receives the same RuntimeConfigStore that the admin API is wired to', async () => {
		const { log } = fakeLog();
		const { runners, replayerCalls } = fakeRunners();
		await main([validConfig], log, runners);
		expect(replayerCalls[0]!.runtimeStore.getLogLevel()).toBe('info');
	});

	test('the shared HTTP server + admin API (GET /get, POST /set) start even when neither REPORTER nor REPLAYER is active', async () => {
		const { log } = fakeLog();
		let releaseCleaner: () => void = () => {};
		const runners: RoleRunners = {
			subscriber: async () => {},
			downloader: async () => {},
			cleaner: async () => {
				await new Promise<void>((resolve) => {
					releaseCleaner = resolve;
				});
			},
			reporter: async () => {},
			replayer: async () => {},
			heartbeat: async () => {},
			connectMqtt: async () => fakeMqttLike(),
			connectMqttBestEffort: async () => fakeMqttLike(),
		};

		const donePromise = main([cleanerOnlyConfig], log, runners);
		// Let main() get past config loading and bind the HTTP server
		// before CLEANER's fake blocks forever.
		await new Promise((resolve) => setTimeout(resolve, 20));

		const getRes = await fetch('http://localhost:18724/get?key=process-mode');
		expect(getRes.status).toBe(200);
		expect(await getRes.json()).toEqual({ 'process-mode': 'run' });

		// worker/queue are unrestricted (roles: null) -- reachable even
		// though this replica carries only CLEANER.
		const workerRes = await fetch('http://localhost:18724/get?key=worker');
		expect(await workerRes.json()).toEqual({ worker: 'wis2-cleaner-only' });

		// whitelist is SUBSCRIBER-gated -- 403 on a CLEANER-only replica.
		const whitelistRes = await fetch('http://localhost:18724/get?key=whitelist');
		expect(whitelistRes.status).toBe(403);

		const setRes = await fetch('http://localhost:18724/set', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ 'log-level': 'debug' }),
		});
		expect(setRes.status).toBe(200);
		const setBody = (await setRes.json()) as { changes: Record<string, unknown> };
		expect(setBody.changes['log-level']).toEqual({ value: 'debug', changed: true });

		releaseCleaner();
		const code = await donePromise;
		expect(code).toBe(0);
	});
});
