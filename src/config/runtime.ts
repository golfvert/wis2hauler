// Validation for the small, live-mutable subset of config exposed
// over the HTTP PATCH-style API — process-mode, log-level, whitelist,
// blacklist, overridelist, credentials (CRUD). Ported from the
// Node-RED "Updates" function node (Setup tab) in flows.json, which
// is deliberately a much smaller surface than the static YAML config
// in schema.ts/validate.ts: only these six keys can be changed without
// a restart.
//
// Scope note: this module validates a patch body and reports what
// would change and why a key was rejected — it does NOT itself own or
// mutate live process state (the equivalent of Node-RED's global.set
// calls). The original couples validation tightly to Node-RED's
// global context (reading/writing global.get/set inline); here that's
// deliberately split out, since "is this patch valid" and "how does
// the Subscriber/Downloader role apply it to its own live state" are
// different concerns once they're not forced into one function node.
// The whitelist/replay-topic merge behavior in particular (preserving
// replay/a/wis2/... subscriptions across a whitelist update, carrying
// over each topic's QoS) is Subscriber-role state, not config-module
// state, and belongs with that role's own implementation.

import { isValidMqttTopic, isValidCredentialTopic, isValidTopicPattern } from './topics.ts';
import { VALID_ROLES, type OverrideRule, type Role } from './schema.ts';
import { DEBUG_CATEGORIES, type DebugCategory } from '../debug.ts';

export type ProcessMode = 'run' | 'halt';
export type LogLevel = 'info' | 'warn' | 'debug';

export type CredentialOp =
	| { op: 'create' | 'update'; topic: string; username: string; password: string }
	| { op: 'delete'; topic: string };

// The patchable keys and which role(s) may touch each — null means
// "any role". Matches the original's `schema` object in Updates
// exactly (including which fields are role-gated at all).
const PATCHABLE_ROLES: Record<string, readonly Role[] | null> = {
	'process-mode': null,
	'log-level': null,
	// NOT in flows.json -- the maintainer's explicit addition this session ("I want
	// the same /get /set /replayer 'api' endpoint... With the addition of
	// being able to restrict the level change to particular roles. Eg.
	// move subscriber to debug."). Unrestricted like 'log-level' itself:
	// any active role may set any OTHER role's override (there's no
	// original behavior to mirror here, so this follows 'log-level's own
	// precedent rather than inventing a narrower rule).
	'log-level-role': null,
	whitelist: ['SUBSCRIBER'],
	blacklist: ['SUBSCRIBER'],
	overridelist: ['SUBSCRIBER'],
	credentials: ['DOWNLOADER'],
	// NOT in flows.json -- replaces both the old --debug-file live-
	// reloaded-file mechanism and, later, a static -d CLI flag (see
	// ../debug.ts's header, "DELIBERATE CHANGE, 2026-09-12"): the
	// maintainer wants debug categories controlled the exact same way as
	// every other piece of live-mutable state, through this same
	// /get /set API, nothing else. Unrestricted like 'log-level' itself
	// -- there's no natural role restriction for "which roles' debug
	// output can be toggled" the way whitelist/blacklist are
	// SUBSCRIBER-only.
	debug: null,
};

export function isKeyAllowed(key: string, activeRoles: ReadonlySet<Role>): boolean {
	const allowed = PATCHABLE_ROLES[key];
	if (allowed === undefined) return false; // unknown key
	if (allowed === null) return true;
	return allowed.some((r) => activeRoles.has(r));
}

// value: null clears a role's override, falling back to the plain
// 'log-level' default again -- not in the original (see PATCHABLE_ROLES
// above), a deliberate addition since a per-role override needs some way
// to be undone without a restart.
export interface LogLevelRolePatch {
	role: Role;
	value: LogLevel | null;
}

export interface ValidatedPatch {
	'process-mode'?: ProcessMode;
	'log-level'?: LogLevel;
	'log-level-role'?: LogLevelRolePatch;
	whitelist?: string[];
	blacklist?: string[];
	overridelist?: OverrideRule[];
	credentials?: CredentialOp;
	debug?: DebugCategory[];
}

export interface PatchResult {
	values: ValidatedPatch;
	errors: string[];
}

function validateOverridelist(items: unknown[]): string[] {
	const errs: string[] = [];
	items.forEach((entry, i) => {
		const base = `overridelist[${i}]`;
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
			errs.push(`${base}: must be an object with 'topic' and/or 'max-length'`);
			return;
		}
		const e = entry as Record<string, unknown>;
		const unknown = Object.keys(e).filter((k) => !['topic', 'max-length'].includes(k));
		if (unknown.length) errs.push(`${base}: unknown key(s): ${unknown.join(', ')} — only 'topic' and 'max-length' allowed`);
		if (e.topic === undefined && e['max-length'] === undefined) errs.push(`${base}: must define 'topic' and/or 'max-length'`);
		if (e.topic !== undefined && !isValidTopicPattern(e.topic)) errs.push(`${base}.topic: '${String(e.topic)}' — only alphanumeric, -, +, # and / allowed`);
		if (e['max-length'] !== undefined) {
			if (typeof e['max-length'] !== 'number') errs.push(`${base}.max-length: must be a number (bytes)`);
			else if (e['max-length'] <= 0) errs.push(`${base}.max-length: must be greater than 0`);
		}
	});
	return errs;
}

// REMOVED 2026-09-19: this used to declare ValidatePatchOptions
// (globalCacheMode + warn) purely to feed the WIS2 core/cache rule
// (../config/topics.ts's now-removed enforceCoreCacheRule) applied to
// a whitelist/blacklist patch below. See topics.ts's removal comment
// for why that rewrite was replaced with an ingest-time blacklist
// filter (../subscriber/ingest.ts) instead -- a live POST /set patch
// gets the same protection for free now, since it runs against every
// message's real topic regardless of when/how the whitelist was set.

// Validates one PATCH body against every key present in it. Mirrors
// the original's per-key branch (enum / array / objarray / crud)
// exactly, including which failures are fatal for that key alone (the
// original lets other, valid keys in the same body still apply — see
// PatchResult.errors vs. .values: a rejected key is simply absent from
// .values, not a reason to fail the whole patch).
export function validatePatch(body: unknown, activeRoles: ReadonlySet<Role>): PatchResult {
	const errors: string[] = [];
	const values: ValidatedPatch = {};

	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return { values, errors: ['Body must be a JSON object.'] };
	}

	for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
		if (!(key in PATCHABLE_ROLES)) {
			errors.push(`${key}: unknown key.`);
			continue;
		}
		if (!isKeyAllowed(key, activeRoles)) {
			errors.push(`${key}: not available for current roles.`);
			continue;
		}

		switch (key) {
			case 'process-mode': {
				const v = (typeof value === 'string' ? value : '').trim().toLowerCase();
				if (v !== 'run' && v !== 'halt') { errors.push(`${key}: invalid value. Must be one of: run, halt.`); break; }
				values['process-mode'] = v;
				break;
			}
			case 'log-level': {
				const v = (typeof value === 'string' ? value : '').trim().toLowerCase();
				if (v !== 'info' && v !== 'warn' && v !== 'debug') { errors.push(`${key}: invalid value. Must be one of: info, warn, debug.`); break; }
				values['log-level'] = v;
				break;
			}
			case 'log-level-role': {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${key}: must be an object with 'role' and 'value'.`); break; }
				const v = value as Record<string, unknown>;
				const role = (typeof v.role === 'string' ? v.role : '').trim().toUpperCase();
				if (!(VALID_ROLES as readonly string[]).includes(role)) { errors.push(`${key}.role: invalid value. Must be one of: ${VALID_ROLES.join(', ')}.`); break; }
				if (v.value === null) { values['log-level-role'] = { role: role as Role, value: null }; break; }
				const lvl = (typeof v.value === 'string' ? v.value : '').trim().toLowerCase();
				if (lvl !== 'info' && lvl !== 'warn' && lvl !== 'debug') { errors.push(`${key}.value: invalid value. Must be one of: info, warn, debug, or null to clear.`); break; }
				values['log-level-role'] = { role: role as Role, value: lvl };
				break;
			}
			case 'whitelist':
			case 'blacklist': {
				if (!Array.isArray(value)) { errors.push(`${key}: must be an array of strings.`); break; }
				const items = value.map((t) => (typeof t === 'string' ? t.trim() : '')).filter((t) => t.length > 0);
				if (items.length === 0) { errors.push(`${key}: array must not be empty.`); break; }
				const itemErrors = key === 'whitelist'
					? items.flatMap((t, i) => { const e = isValidMqttTopic(t); return e ? [`whitelist[${i}]: '${t}' — ${e}`] : []; })
					: items.flatMap((t, i) => (isValidTopicPattern(t) ? [] : [`blacklist[${i}]: '${t}' — only alphanumeric, -, +, # and / allowed`]));
				if (itemErrors.length > 0) { errors.push(...itemErrors); break; }
				values[key] = items;
				break;
			}
			case 'overridelist': {
				if (!Array.isArray(value)) { errors.push(`${key}: must be an array.`); break; }
				const itemErrors = validateOverridelist(value);
				if (itemErrors.length > 0) { errors.push(...itemErrors); break; }
				values.overridelist = value as OverrideRule[];
				break;
			}
			case 'debug': {
				if (!Array.isArray(value)) { errors.push(`${key}: must be an array of strings.`); break; }
				// Unlike whitelist/blacklist, an EMPTY array is valid here --
				// it's the only way to clear every category back to nothing
				// (there's no static baseline underneath any more -- see
				// ../debug.ts's header), same as 'log-level-role's
				// `value: null` clear.
				const normalized = value.map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : ''));
				const itemErrors = normalized.flatMap((v, i) =>
					DEBUG_CATEGORIES.has(v) ? [] : [`debug[${i}]: '${String(value[i])}' — must be one of: ${[...DEBUG_CATEGORIES].join(', ')}`],
				);
				if (itemErrors.length > 0) { errors.push(...itemErrors); break; }
				values.debug = [...new Set(normalized)] as DebugCategory[];
				break;
			}
			case 'credentials': {
				if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${key}: must be an object with op and topic.`); break; }
				const v = value as Record<string, unknown>;
				const op = v.op;
				if (op !== 'create' && op !== 'update' && op !== 'delete') { errors.push(`${key}: op must be one of: create, update, delete.`); break; }
				const topicErr = isValidCredentialTopic(v.topic);
				if (topicErr) { errors.push(`${key}.topic: ${topicErr}`); break; }
				if (op === 'delete') { values.credentials = { op, topic: v.topic as string }; break; }
				const username = v.username;
				const password = v.password;
				if (typeof username !== 'string' || username.trim().length === 0) { errors.push(`${key}.username: missing or empty`); break; }
				if (typeof password !== 'string' || password.trim().length === 0) { errors.push(`${key}.password: missing or empty`); break; }
				values.credentials = { op, topic: v.topic as string, username, password };
				break;
			}
		}
	}

	return { values, errors };
}
