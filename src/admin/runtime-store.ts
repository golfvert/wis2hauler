// The Setup tab's live, per-process, in-memory config state -- what
// the original keeps in Node-RED's `global` context (global.get/set),
// mutated by the "Updates" function (../config/runtime.ts's
// validatePatch ports its validation half) and read back by the
// "Config" function (../admin/get.ts ports its read half).
//
// Deliberately per-process, matching the original exactly: Node-RED's
// global context is NOT shared across replicas either, so a PATCH
// applied on one replica was never visible on another in flows.json --
// confirmed by tracing "Updates"' second output (the "Change ?"/
// "Action ?" switch) and finding no wis2gc:configuration persistence
// or keyspace-notification broadcast for log-level/blacklist/
// overridelist at all (see ../config/runtime.ts's header for the full
// per-key breakdown of what DOES have a live side effect: process-mode,
// whitelist, credentials -- the other four are storage-only, here and
// in the original alike).
import type { Config, OverrideRule, Role } from '../config/schema.ts';
import type { ProcessMode, LogLevel, ValidatedPatch } from '../config/runtime.ts';
import type { LevelGate } from '../logging/logger.ts';

export interface RuntimeConfigState {
	processMode: ProcessMode;
	logLevel: LogLevel;
	// NOT in flows.json -- the maintainer's per-role log-level override addition
	// (see ../config/runtime.ts's 'log-level-role' PATCHABLE_ROLES entry).
	// Empty by default: every role reads the plain `logLevel` above until
	// explicitly overridden.
	logLevelByRole: Partial<Record<Role, LogLevel>>;
	whitelist: string[];
	blacklist: string[];
	overridelist: OverrideRule[];
	// subscriber.mqtt['global-replay'] at startup, then whatever
	// POST /replayer's `global-replay` field last set it to (../replayer/
	// run.ts) -- storage-only in the original, same as logLevel/blacklist/
	// overridelist above (no live subscribe/unsubscribe side effect).
	globalReplay: string | null;
}

/** One key's before/after for a /set (or /replayer) response -- exact shape of the original "Updates" function's `changes` object (key -> {value, changed}). */
export interface ChangeEntry {
	value: unknown;
	changed: boolean;
}

function seedState(config: Config): RuntimeConfigState {
	return {
		processMode: 'run',
		logLevel: config.global.log.level,
		logLevelByRole: {},
		whitelist: config.subscriber?.mqtt.whitelist ?? [],
		blacklist: config.subscriber?.mqtt.blacklist ?? [],
		overridelist: config.subscriber?.mqtt.overridelist ?? [],
		globalReplay: config.subscriber?.mqtt['global-replay'] ?? null,
	};
}

/**
 * Implements ../logging/logger.ts's LevelGate so every module logger
 * can be constructed against this store directly (see ../main.ts) --
 * effectiveLevel(role) is exactly PATCHABLE_ROLES' 'log-level-role'
 * override falling back to the plain 'log-level' default, matching the
 * three gating switch nodes (f3c8b225584944ae/1f8ceb1df55ececd/
 * 96d3af64c93b3b3d) traced in ../logging/levels.ts's header, extended
 * with the per-role layer that has no flows.json equivalent.
 */
export class RuntimeConfigStore implements LevelGate {
	private state: RuntimeConfigState;

	constructor(config: Config) {
		this.state = seedState(config);
	}

	effectiveLevel(role?: Role): LogLevel {
		if (role !== undefined) {
			const override = this.state.logLevelByRole[role];
			if (override !== undefined) return override;
		}
		return this.state.logLevel;
	}

	getProcessMode(): ProcessMode {
		return this.state.processMode;
	}

	getLogLevel(): LogLevel {
		return this.state.logLevel;
	}

	getLogLevelByRole(): Partial<Record<Role, LogLevel>> {
		return { ...this.state.logLevelByRole };
	}

	getWhitelist(): string[] {
		return [...this.state.whitelist];
	}

	getBlacklist(): string[] {
		return [...this.state.blacklist];
	}

	getOverridelist(): OverrideRule[] {
		return [...this.state.overridelist];
	}

	getGlobalReplay(): string | null {
		return this.state.globalReplay;
	}

	setGlobalReplay(value: string | null): ChangeEntry {
		const previous = this.state.globalReplay;
		this.state.globalReplay = value;
		return { value, changed: previous !== value };
	}

	/**
	 * Applies every key present in an already-validated patch (../config/
	 * runtime.ts's validatePatch output), returning the {value,changed}
	 * map the /set response needs -- mirrors the "Updates" function's own
	 * `changed = previous !== value` comparison per key, done once here
	 * instead of duplicated at each call site (POST /set AND, for
	 * 'log-level-role', nowhere else -- but kept general since /set is
	 * this store's only current caller for these six keys).
	 */
	applyPatch(patch: ValidatedPatch): Record<string, ChangeEntry> {
		const changes: Record<string, ChangeEntry> = {};

		if (patch['process-mode'] !== undefined) {
			const previous = this.state.processMode;
			this.state.processMode = patch['process-mode'];
			changes['process-mode'] = { value: patch['process-mode'], changed: previous !== patch['process-mode'] };
		}
		if (patch['log-level'] !== undefined) {
			const previous = this.state.logLevel;
			this.state.logLevel = patch['log-level'];
			changes['log-level'] = { value: patch['log-level'], changed: previous !== patch['log-level'] };
		}
		if (patch['log-level-role'] !== undefined) {
			const { role, value } = patch['log-level-role'];
			const previous = this.state.logLevelByRole[role];
			if (value === null) delete this.state.logLevelByRole[role];
			else this.state.logLevelByRole[role] = value;
			changes['log-level-role'] = { value: { role, value }, changed: previous !== value };
		}
		if (patch.whitelist !== undefined) {
			const previous = this.state.whitelist;
			this.state.whitelist = patch.whitelist;
			changes.whitelist = { value: patch.whitelist, changed: !sameArray(previous, patch.whitelist) };
		}
		if (patch.blacklist !== undefined) {
			const previous = this.state.blacklist;
			this.state.blacklist = patch.blacklist;
			changes.blacklist = { value: patch.blacklist, changed: !sameArray(previous, patch.blacklist) };
		}
		if (patch.overridelist !== undefined) {
			const previous = this.state.overridelist;
			this.state.overridelist = patch.overridelist;
			changes.overridelist = { value: patch.overridelist, changed: JSON.stringify(previous) !== JSON.stringify(patch.overridelist) };
		}
		// 'credentials' is deliberately NOT applied here -- it's a live
		// Redis HSET/HDEL (../downloader/store.ts's setCredential/
		// deleteCredential), not in-memory state this store owns. See
		// ../admin/routes.ts, which calls the credentials store directly
		// and folds its own {value,changed} entry into the same response.

		return changes;
	}
}

function sameArray(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}
