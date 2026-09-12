// createSourceLogger(name) is the module-level binding point every
// file that wants leveled/routed logging uses once, at the top of the
// file -- `const log = createSourceLogger('hash')` -- the closest
// analog in code to what a node's own name was in flows.json (see
// slug.ts's header): one name per meaningful step, bound once rather
// than repeated at every call site.
//
// Level admission (levels.ts) is checked against a LevelGate, which
// resolves the effective level for an optional Role -- per the maintainer's
// explicit addition this session ("restrict the level change to
// particular roles. Eg. move subscriber to debug"), NOT present in
// flows.json: the original's log-level is a single global value with
// no per-role override. admin/runtime-store.ts's RuntimeConfigStore
// is the real LevelGate implementation (global default ∪ per-role
// overrides); tests here use a trivial fake.
import { slugifySource } from './slug.ts';
import { levelAdmits } from './levels.ts';
import type { LogSink } from './sink.ts';
import type { LogLevel } from '../config/runtime.ts';
import type { Role } from '../config/schema.ts';

export interface LevelGate {
	/** The effective level for `role` (or the process-wide default when role is omitted or has no override). */
	effectiveLevel(role?: Role): LogLevel;
}

export interface SourceLogger {
	info(data: Record<string, unknown>): void;
	warn(data: Record<string, unknown>): void;
	debug(data: Record<string, unknown>): void;
}

/**
 * Binds a source name (slugified the same way flows.json's dynamic
 * `_logIO_.fileName` did) to a sink and a level gate. `role`, when
 * given, is what a per-role log-level override (see LevelGate above)
 * applies against -- pass the role this module's logic belongs to
 * (e.g. 'SUBSCRIBER') so "move subscriber to debug" affects exactly
 * its call sites; omit it for role-agnostic infrastructure (Setup/
 * admin, the shared election primitive), which only ever sees the
 * process-wide default.
 */
export function createSourceLogger(name: string, sink: LogSink, gate: LevelGate, role?: Role): SourceLogger {
	const source = slugifySource(name);
	const emit = (level: LogLevel, data: Record<string, unknown>): void => {
		if (levelAdmits(gate.effectiveLevel(role), level)) sink.write(level, source, data);
	};
	return {
		info: (data) => emit('info', data),
		warn: (data) => emit('warn', data),
		debug: (data) => emit('debug', data),
	};
}
