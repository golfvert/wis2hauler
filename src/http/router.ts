// A single shared Bun.serve() instance, one per replica, with routes
// registered by whichever roles are active on that replica --
// necessary because Node-RED's http-in nodes across the Reporter
// (/reporter/primary, /caddy) and Replayer (/replayer/primary) tabs
// all bind to Node-RED's own ONE admin server (settings.js's uiPort,
// not itself part of flows.json). Per the maintainer's explicit decision this
// session ("nodered offers one port... for all HTTP access. So, [one
// shared Bun.serve] will behave the same."): main.ts owns exactly one
// HttpServerHandle per process (only when REPORTER and/or REPLAYER is
// an active role) and hands its `router` to runReporter()/
// runReplayer() so each registers its own routes rather than each
// calling Bun.serve() itself -- two Bun.serve() calls on the same
// port would collide (EADDRINUSE) on a replica carrying both roles.
export type HttpHandler = (req: Request) => Response | Promise<Response>;

export interface HttpRouter {
	get(path: string, handler: HttpHandler): void;
	post(path: string, handler: HttpHandler): void;
}

export interface HttpServerHandle {
	router: HttpRouter;
	/** The actual bound port -- same as the requested `port`, except when `port` was 0 (OS-assigned), useful for tests. */
	port: number;
	stop(): void;
}

export function createHttpServer(port: number): HttpServerHandle {
	const routes = new Map<string, HttpHandler>();
	const routeKey = (method: string, path: string): string => `${method} ${path}`;

	const router: HttpRouter = {
		get(path, handler) {
			routes.set(routeKey('GET', path), handler);
		},
		post(path, handler) {
			routes.set(routeKey('POST', path), handler);
		},
	};

	const server = Bun.serve({
		port,
		fetch: async (req) => {
			const url = new URL(req.url);
			const handler = routes.get(routeKey(req.method, url.pathname));
			if (!handler) return new Response('Not Found', { status: 404 });
			return handler(req);
		},
	});

	return { router, port: server.port ?? port, stop: () => server.stop() };
}
