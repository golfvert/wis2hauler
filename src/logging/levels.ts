// The cumulative INFO/WARN/DEBUG severity gate, ported from the three
// JSONata switches gating flows.json's "Info"/"Warn"/"Debug" link-in
// nodes (Setup tab, f3c8b225584944ae / 1f8ceb1df55ececd / 96d3af64c93b3b3d):
//
//   INFO passes when log-level is "info", "warn", or "debug" (i.e.
//   always, since those are the only three legal values).
//   WARN passes only when log-level is "warn" or "debug".
//   DEBUG passes only when log-level is exactly "debug".
//
// So "debug" is the most permissive setting (admits everything),
// "info" the least (admits only info-tagged calls) -- a verbosity
// ladder, not a severity threshold in the usual sense (compare
// node.error(), which the original routes entirely outside this
// system -- see this module's sibling files' headers).
import type { LogLevel } from '../config/runtime.ts';

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, debug: 2 };

/** True when a message tagged `messageLevel` should be emitted under the configured `level`. */
export function levelAdmits(configuredLevel: LogLevel, messageLevel: LogLevel): boolean {
	return RANK[messageLevel] <= RANK[configuredLevel];
}
