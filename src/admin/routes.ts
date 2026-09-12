// Wires the Setup tab's admin API onto the shared HTTP router (../http/
// router.ts) -- GET /get and POST /set, ported per the maintainer's explicit
// instruction this session ("I want the same /get /set /replayer 'api'
// endpoint. See setup tab. I want to reproduce that."). POST /replayer
// lives in ../replayer/run.ts instead (it needs that role's own
// election/primary-gate state, see that file), not here.
//
// Unlike Reporter/Replayer's routes, this API isn't gated to one role
// being active -- every one of the original's 3 Setup-tab endpoints is
// reachable regardless of which roles a given Node-RED instance runs
// (there's no role check on the http-in nodes themselves, only on
// individual fields/keys within each -- see ../config/runtime.ts's
// PATCHABLE_ROLES and ./get.ts's GET_FIELDS). So ../main.ts registers
// this unconditionally, alongside the now-always-on HTTP server.
import type { HttpRouter } from '../http/router.ts';
import type { Config, Role } from '../config/schema.ts';
import type { RuntimeConfigStore } from './runtime-store.ts';
import type { DownloaderStore } from '../downloader/store.ts';
import type { SourceLogger } from '../logging/logger.ts';
import type { DebugController } from '../debug.ts';
import { GET_FIELDS, buildGetResponse } from './get.ts';
import { buildSetResponse } from './set.ts';

export interface AdminRouteDeps {
	config: Config;
	store: RuntimeConfigStore;
	activeRoles: ReadonlySet<Role>;
	// Only non-null when DOWNLOADER is an active role on this replica --
	// see ./get.ts's GetContext / ./set.ts's SetContext doc comments.
	credentialsStore: DownloaderStore | null;
	// Always present -- see ./get.ts's GetContext doc comment.
	debug: DebugController;
	log: typeof console;
	// "Change ?" (Setup tab, previous-node eeca55e8996b39fc, Info) --
	// bound to the shared module-logger sink/gate in ../main.ts. Optional
	// purely so any hand-constructed AdminRouteDeps elsewhere (tests)
	// keeps compiling without it.
	changeLogger?: SourceLogger;
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function registerAdminRoutes(router: HttpRouter, deps: AdminRouteDeps): void {
	const warn = (message: string): void => deps.log.warn(`ADMIN: ${message}`);
	const ctxBase = { config: deps.config, store: deps.store, credentialsStore: deps.credentialsStore, debug: deps.debug, warn };

	router.get('/get', async (req) => {
		const url = new URL(req.url);
		const key = url.searchParams.get('key') ?? undefined;
		const result = await buildGetResponse(GET_FIELDS, deps.activeRoles, ctxBase, key);
		return jsonResponse(result.status, result.body);
	});

	router.post('/set', async (req) => {
		let body: unknown;
		try {
			body = await req.json();
		} catch {
			return jsonResponse(400, { changes: {}, errors: ['Body must be valid JSON.'] });
		}
		const globalCacheMode = deps.config.global['global-cache'] ?? false;
		const result = await buildSetResponse(body, deps.activeRoles, { store: deps.store, credentialsStore: deps.credentialsStore, debug: deps.debug, warn, globalCacheMode });
		// "Change ?" -- one Info log per key the patch actually changed,
		// matching the original's own "Change ?" switch (7b0525ef3667eb54)
		// only routing a key onward to logging when its {value,changed}
		// comparison came back changed=true.
		for (const [key, entry] of Object.entries(result.body.changes)) {
			if (entry.changed) deps.changeLogger?.info({ key, value: entry.value });
		}
		return jsonResponse(result.status, result.body);
	});
}
