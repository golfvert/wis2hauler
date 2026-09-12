// Top-level wiring for a live REPLAYER role: connects to Redis (one
// command connection -- no dedicated psubscribe connection needed,
// unlike Cleaner/Reporter, since Replayer has no redis-in psubscribe
// node of its own), and runs its 1 concurrent loop plus one route on
// the shared HTTP router (../http/router.ts -- see reporter/run.ts's
// header for why this is shared, not its own Bun.serve()) until the
// given AbortSignal fires:
//   - Election (../election/elector.ts, shared primitive, 10s poll,
//     role="replayer").
//   - Route: GET /replayer/primary (200 if primary, 404 otherwise --
//     5ec4cf3c7798d026), gated on role-active only, NOT primary
//     (c7c61be8cbf08a09) -- same shape as Reporter's own primary
//     endpoint.
//
//   - Route: POST /replayer (traced this session): {'global-replay'?:
//     string, 'replay'?: {from, to}} (minutes ago) -- 403 when not
//     primary (047d004f744e77fb), otherwise validates the body
//     (./request.ts), stores 'global-replay' on the shared
//     RuntimeConfigStore (../admin/runtime-store.ts -- the SAME
//     instance GET /get and POST /set read/write, so a value set here
//     is visible there too), and fires replay.ts's triggerReplay() for
//     a `replay` request -- exactly the caller replay.ts's own header
//     said was out of scope until this phase. Response shape matches
//     ../admin/set.ts's /set: {changes, errors?}.
import type { Config } from '../config/schema.ts';
import type { DebugController } from '../debug.ts';
import { createRedisConnection } from '../redis/ioredis-store.ts';
import { IoredisElectionStore } from '../redis/ioredis-election-store.ts';
import { runElectionLoop } from '../election/elector.ts';
import type { HttpRouter } from '../http/router.ts';
import type { RuntimeConfigStore, ChangeEntry } from '../admin/runtime-store.ts';
import { validateReplayerRequest } from './request.ts';
import { triggerReplay, type ReplayRequest } from './replay.ts';

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** "Extract" change node's real HTTP call -- ../replay.ts's ReplayRequest -> an actual fetch POST. */
async function postReplayRequest(req: ReplayRequest): Promise<void> {
	const headers: Record<string, string> = {};
	for (const h of req.headers) {
		const idx = h.indexOf(':');
		if (idx === -1) continue;
		headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
	}
	await fetch(req.url, { method: req.method, headers, body: req.body });
}

export async function runReplayer(config: Config, debug: DebugController, log: typeof console, signal: AbortSignal, processUuid: string, router: HttpRouter, runtimeStore: RuntimeConfigStore): Promise<void> {
	const isDebugEnabled = () => debug.has('REPLAYER');

	const commandConn = createRedisConnection(config.global.redis);
	const electionStore = new IoredisElectionStore(commandConn);

	const state = { primary: false };

	const electionLoop = runElectionLoop(
		{
			store: electionStore,
			role: 'replayer',
			uuid: processUuid,
			onResult: (priority) => {
				state.primary = priority === 'primary';
				if (isDebugEnabled()) log.log(`REPLAYER: election -> ${priority}`);
			},
			warn: (m) => log.warn(`REPLAYER: ${m}`),
		},
		signal,
		defaultSleep,
	);

	router.get('/replayer/primary', () => new Response(null, { status: state.primary ? 200 : 404 }));

	router.post('/replayer', async (req) => {
		if (!state.primary) return new Response(null, { status: 403 });

		let rawBody: unknown;
		try {
			rawBody = await req.json();
		} catch {
			return jsonResponse(400, { changes: {}, errors: ['Body must be valid JSON.'] });
		}

		const { patch, errors } = validateReplayerRequest(rawBody, Date.now());
		const changes: Record<string, ChangeEntry> = {};

		if (patch.globalReplay !== undefined) {
			changes['global-replay'] = runtimeStore.setGlobalReplay(patch.globalReplay);
		}

		if (patch.replayRange !== undefined) {
			changes.replay = { value: patch.replayRange, changed: true };
			const { from, to } = patch.replayRange;
			// Fired off, not awaited: REPLAY_RATE_LIMIT_MS (10s) between each
			// discovered topic's request means a wide replay window can take
			// a while -- same "accept, then work in the background" shape as
			// reporter/run.ts's /caddy handler.
			void triggerReplay(
				{
					readElectionHash: () => electionStore.readElectionHash(),
					// validate.ts's cross-check guarantees `replayer:` is present
					// whenever REPLAYER is an active role -- see config/validate.ts.
					globalReplayUrl: config.replayer!['global-replay-url'],
					uuid: processUuid,
					postReplayRequest,
					sleep: defaultSleep,
				},
				from,
				to,
			).catch((err) => log.error(`REPLAYER: replay trigger failed: ${err instanceof Error ? err.message : String(err)}`));
		}

		const hasChanges = Object.keys(changes).length > 0;
		return jsonResponse(hasChanges ? 200 : 400, { changes, ...(errors.length > 0 ? { errors } : {}) });
	});

	log.log('REPLAYER: election loop starting');
	await electionLoop;
	log.log('REPLAYER: shutdown signalled, closing connections');

	await commandConn.quit();
}
