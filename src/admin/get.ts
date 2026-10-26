// The Setup tab's "Config" function node (schema-driven GET /get,
// traced this session): a fixed table of readable keys, each gated by
// `roles: null|Role[]` (null = any active role) exactly like ../config/
// runtime.ts's PATCHABLE_ROLES for /set, plus a getter. `?key=X`
// returns just that field (400 unknown key, 403 not allowed for the
// current roles); no `key` returns every field the current roles are
// allowed to see.
//
// 'log-level-role' is NOT in the original's schema -- exposed here
// purely so a caller of the new per-role override (../config/
// runtime.ts's 'log-level-role' PATCHABLE_ROLES entry) can read back
// what's currently set, same reasoning as the write side's own doc
// comment.
import type { Config, Role } from '../config/schema.ts';
import type { RuntimeConfigStore } from './runtime-store.ts';
import type { DownloaderStore } from '../downloader/store.ts';
import { parseCredentials, type CredentialMap } from '../downloader/credentials.ts';

export interface GetContext {
	config: Config;
	store: RuntimeConfigStore;
	// Only present on a replica carrying DOWNLOADER -- ../main.ts only
	// constructs one when that role is active, matching this field's
	// own role gate below (isFieldAllowed already refuses the request
	// before get() would ever run with credentialsStore === null).
	credentialsStore: DownloaderStore | null;
	warn: (message: string) => void;
}

export interface GetField {
	roles: readonly Role[] | null;
	/** Deprecated alias (ADR 0012): answered when asked for by name, left out of the full listing. */
	deprecatedFor?: string;
	get: (ctx: GetContext) => unknown | Promise<unknown>;
}

export const GET_FIELDS: Record<string, GetField> = {
	'process-mode': { roles: null, get: (ctx) => ctx.store.getProcessMode() },
	'log-level': { roles: null, get: (ctx) => ctx.store.getLogLevel() },
	'log-level-role': { roles: null, get: (ctx) => ctx.store.getLogLevelByRole() },
	worker: { roles: null, get: (ctx) => ctx.config.global.worker },
	queue: { roles: null, get: (ctx) => ctx.config.global.queue ?? null },
	subscribe: { roles: ['SUBSCRIBER'], get: (ctx) => ctx.store.getSubscribe() },
	exclude: { roles: ['SUBSCRIBER'], get: (ctx) => ctx.store.getExclude() },
	whitelist: { roles: ['SUBSCRIBER'], deprecatedFor: 'subscribe', get: (ctx) => ctx.store.getSubscribe() },
	blacklist: { roles: ['SUBSCRIBER'], deprecatedFor: 'exclude', get: (ctx) => ctx.store.getExclude() },
	'global-replay': { roles: null, get: (ctx) => ctx.store.getGlobalReplay() },
	credentials: {
		roles: ['DOWNLOADER'],
		get: async (ctx): Promise<CredentialMap> => {
			if (!ctx.credentialsStore) return {};
			return parseCredentials(await ctx.credentialsStore.getCredentials(), ctx.warn);
		},
	},
};

export function isFieldAllowed(field: GetField, activeRoles: ReadonlySet<Role>): boolean {
	return field.roles === null || field.roles.some((r) => activeRoles.has(r));
}

export interface GetResult {
	status: 200 | 400 | 403;
	body: Record<string, unknown>;
}

/** Pure decision: builds the /get response body + status for a given (possibly absent) `key`. HTTP framing (parsing the query string, wrapping in a Response) is ../routes.ts's job, not this function's -- kept separate so this is unit-testable without a real request. */
export async function buildGetResponse(fields: Record<string, GetField>, activeRoles: ReadonlySet<Role>, ctx: GetContext, key?: string): Promise<GetResult> {
	if (key !== undefined) {
		const field = fields[key];
		if (!field) return { status: 400, body: { error: `${key}: unknown key.` } };
		if (!isFieldAllowed(field, activeRoles)) return { status: 403, body: { error: `${key}: not available for current roles.` } };
		if (field.deprecatedFor) ctx.warn(`${key}: deprecated, use '${field.deprecatedFor}'.`);
		return { status: 200, body: { [key]: await field.get(ctx) } };
	}

	const body: Record<string, unknown> = {};
	for (const [k, field] of Object.entries(fields)) {
		if (!field.deprecatedFor && isFieldAllowed(field, activeRoles)) body[k] = await field.get(ctx);
	}
	return { status: 200, body };
}
