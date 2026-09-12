// Runtime debug toggling — a static (CLI) baseline unioned with a
// dynamic set controlled entirely through the HTTP admin API (GET
// /get, POST /set — see ../admin/get.ts, ../admin/set.ts), so logging
// can be turned on/off without a restart (a restart isn't free for an
// elected role — see the project's architecture notes). Ported (logic
// only) from the Go "antiloop" port's debugFlag — see the "antiloop
// debug pattern" section of the architecture notes and the "Decision:
// reuse this logic as-is" note there. The POST /inject replay endpoint
// from that codebase is explicitly NOT part of this — debug toggling
// only.
//
// DELIBERATE CHANGE, 2026-09-12: antiloop's own mechanism (and this
// port's first pass at it) reloaded the dynamic set from a live-
// watched file on disk, polled every 10s. the maintainer rejected that outright
// once the Docker mount layout made the file's default path awkward
// ("Forget that. No need to read a debug file. Everything is /get
// /set, and nothing else."): this process already has exactly one
// live-mutation channel for every other piece of runtime-patchable
// state (process-mode, log-level, whitelist, ...) — the admin HTTP
// API — and debug categories should be no exception, not a second,
// file-based channel living alongside it. setDynamic()/getDynamic()
// below are what ../config/runtime.ts's 'debug' PATCHABLE_ROLES entry
// and ../admin/get.ts's 'debug' GET_FIELDS entry call into; there is
// no file, no polling, no --debug-file CLI flag any more.
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
// /set) and ../main.ts's -d CLI validation can both check membership
// against the exact same set, instead of each keeping its own copy.
export const DEBUG_CATEGORIES: ReadonlySet<string> = new Set<string>([...VALID_ROLES, 'ALL']);

export interface DebugOptions {
	/** The static baseline, normally from a repeatable -d CLI flag (see main.ts's parseCli). Fixed for the process's lifetime — never touched by setDynamic(). */
	staticCategories?: Iterable<DebugCategory>;
	/**
	 * Roles that gate a global side effect (e.g. flipping a library's
	 * own verbose-logging switch) rather than being checked per log
	 * call. onChange[role] is invoked only when the EFFECTIVE
	 * (static ∪ dynamic) state for that role actually changes — never
	 * on every setDynamic() call — mirroring antiloop's pahoLogging/
	 * dedupLogging "diff and re-apply" handling, which exists because
	 * antiloop shipped with that re-apply step missing for months
	 * before the bug was caught (see the architecture notes). The
	 * diff-before-calling behavior here is deliberate, not incidental.
	 */
	onChange?: Partial<Record<DebugCategory, (enabled: boolean) => void>>;
}

export class DebugController {
	private readonly staticSet: ReadonlySet<DebugCategory>;
	private dynamicSet: ReadonlySet<DebugCategory> = new Set();
	private readonly onChange: Partial<Record<DebugCategory, (enabled: boolean) => void>>;
	private readonly lastApplied = new Map<DebugCategory, boolean>();

	constructor(options: DebugOptions = {}) {
		this.staticSet = new Set(options.staticCategories ?? []);
		this.onChange = options.onChange ?? {};
		// Apply the static baseline for onChange roles immediately, same
		// as antiloop's startup EnableLogging(dbg.has("paho")) calls
		// before any dynamic categories have ever been set.
		for (const role of Object.keys(this.onChange) as DebugCategory[]) this.applyIfChanged(role);
	}

	/** Effective state right now for one role: static ∪ dynamic, with "ALL" as a shorthand for every role. */
	has(role: Role): boolean {
		return (
			this.staticSet.has('ALL') ||
			this.staticSet.has(role) ||
			this.dynamicSet.has('ALL') ||
			this.dynamicSet.has(role)
		);
	}

	private applyIfChanged(role: DebugCategory): void {
		const effective = role === 'ALL' ? true : this.has(role);
		if (this.lastApplied.get(role) !== effective) {
			this.lastApplied.set(role, effective);
			this.onChange[role]?.(effective);
		}
	}

	/** Everything the dynamic (admin-API-set) layer currently has on — what GET /get?key=debug reads back. Does NOT include the static baseline: that's fixed at startup and was never something /set could touch anyway. */
	getDynamic(): DebugCategory[] {
		return [...this.dynamicSet];
	}

	/**
	 * Replaces the dynamic set WHOLESALE — not merged incrementally —
	 * same semantics the old file-reload had: purely additive on top of
	 * the static baseline, so a category a previous /set call turned on
	 * goes back off if it's absent from this call, but a category set
	 * via the static baseline can never be turned off this way. Callers
	 * (../admin/set.ts) are expected to have already validated every
	 * entry against DEBUG_CATEGORIES (../config/runtime.ts's 'debug'
	 * patch validation) — this still filters defensively, since a
	 * mistaken direct call (e.g. from a test) shouldn't silently
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
