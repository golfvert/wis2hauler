// Runtime debug toggling, controlled entirely through the HTTP admin
// API (GET /get, POST /set — see ../admin/get.ts, ../admin/set.ts), so
// logging can be turned on/off without a restart (a restart isn't
// free for an elected role — see the project's architecture notes).
// Ported (logic only) from the Go "antiloop" port's debugFlag — see
// the "antiloop debug pattern" section of the architecture notes and
// the "Decision: reuse this logic as-is" note there. The POST /inject
// replay endpoint from that codebase is explicitly NOT part of this —
// debug toggling only.
//
// DELIBERATE CHANGE, 2026-09-12: two earlier mechanisms for this are
// both gone now. antiloop's own approach (and this port's first pass
// at it) reloaded the set from a live-watched file on disk, polled
// every 10s — the maintainer rejected that outright once the Docker mount
// layout made the file's default path awkward ("Forget that. No need
// to read a debug file. Everything is /get /set, and nothing else.").
// A second mechanism, a static -d CLI flag setting a startup-only
// baseline unioned with the admin-API-set state, was removed later for
// the same reason: the maintainer wants exactly ONE channel for every piece
// of runtime-patchable state (process-mode, log-level, whitelist,
// ...) — the admin HTTP API — with no second, CLI- or file-based path
// competing with it. setDynamic()/getDynamic() below are what
// ../config/runtime.ts's 'debug' PATCHABLE_ROLES entry and
// ../admin/get.ts's 'debug' GET_FIELDS entry call into; there is no
// file, no CLI flag, no static baseline, no polling — this class holds
// exactly the state POST /set has put into it, nothing more.
//
// Granularity is ROLES, not free-form categories: antiloop used
// arbitrary keywords (subscriber/checks/dedup/paho/...), but here the
// toggle is exactly the same five roles a process can be configured
// to run (see config/schema.ts's VALID_ROLES), plus the "ALL"
// shorthand. That keeps debug output scoped to something a config
// file already has a name for, instead of inventing a second,
// looser vocabulary.

import { VALID_ROLES, type Role } from './config/schema.ts';

export type DebugCategory = Role | 'ALL';

// Exported so ../config/runtime.ts's 'debug' patch validation (POST
// /set) can check membership against the exact same set this module
// uses internally.
export const DEBUG_CATEGORIES: ReadonlySet<string> = new Set<string>([...VALID_ROLES, 'ALL']);

export interface DebugOptions {
	/**
	 * Roles that gate a global side effect (e.g. flipping a library's
	 * own verbose-logging switch) rather than being checked per log
	 * call. onChange[role] is invoked only when the EFFECTIVE state for
	 * that role actually changes — never on every setDynamic() call —
	 * mirroring antiloop's pahoLogging/dedupLogging "diff and re-apply"
	 * handling, which exists because antiloop shipped with that
	 * re-apply step missing for months before the bug was caught (see
	 * the architecture notes). The diff-before-calling behavior here is
	 * deliberate, not incidental.
	 */
	onChange?: Partial<Record<DebugCategory, (enabled: boolean) => void>>;
}

export class DebugController {
	private dynamicSet: ReadonlySet<DebugCategory> = new Set();
	private readonly onChange: Partial<Record<DebugCategory, (enabled: boolean) => void>>;
	private readonly lastApplied = new Map<DebugCategory, boolean>();

	constructor(options: DebugOptions = {}) {
		this.onChange = options.onChange ?? {};
		// Apply the (empty) initial state for onChange roles immediately,
		// same as antiloop's startup EnableLogging(dbg.has("paho")) calls
		// before any category has ever been set via POST /set.
		for (const role of Object.keys(this.onChange) as DebugCategory[]) this.applyIfChanged(role);
	}

	/** Effective state right now for one role, with "ALL" as a shorthand for every role. */
	has(role: Role): boolean {
		return this.dynamicSet.has('ALL') || this.dynamicSet.has(role);
	}

	private applyIfChanged(role: DebugCategory): void {
		const effective = role === 'ALL' ? true : this.has(role);
		if (this.lastApplied.get(role) !== effective) {
			this.lastApplied.set(role, effective);
			this.onChange[role]?.(effective);
		}
	}

	/** Everything currently on — what GET /get?key=debug reads back. */
	getDynamic(): DebugCategory[] {
		return [...this.dynamicSet];
	}

	/**
	 * Replaces the whole set WHOLESALE — not merged incrementally.
	 * Callers (../admin/set.ts) are expected to have already validated
	 * every entry against DEBUG_CATEGORIES (../config/runtime.ts's
	 * 'debug' patch validation) — this still filters defensively, since
	 * a mistaken direct call (e.g. from a test) shouldn't silently
	 * corrupt state with a garbage category.
	 */
	setDynamic(categories: Iterable<string>): void {
		const next = new Set<DebugCategory>();
		for (const raw of categories) {
			const category = raw.trim().toUpperCase();
			if (DEBUG_CATEGORIES.has(category)) next.add(category as DebugCategory);
		}
		this.dynamicSet = next;
		for (const role of Object.keys(this.onChange) as DebugCategory[]) this.applyIfChanged(role);
	}
}
