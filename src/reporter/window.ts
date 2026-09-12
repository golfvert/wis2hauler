// The Reporter tab's "HashStat" function node (0114eaab13d782d9) --
// ported field-for-field. A self-scheduling 30-second-aligned window
// clock: every time the wall clock crosses a :00/:30 boundary, it
// stamps the window that just STARTED into flow.get('hashstat') (so
// "Stats" (stats.ts) writes new data into the CURRENT window) and
// sends the window that just ENDED (30s ago) downstream to "Metrics"
// (metrics.ts) to aggregate and report. Kicked off exactly once by
// the "Start" inject (4c068ca18d8cf9da, onceDelay 2s, no repeat)
// through the "Reporter ?" gate (9bf83f610940c63a) -- see run.ts for
// that one-shot gating; the recurring schedule itself is intrinsic to
// this function (setTimeout chaining to the next 30s boundary), not
// re-gated on every tick in the original.
export const STATS_WINDOW_SECONDS = 30;

/** wis2gc:stats:YYYYMMDDHHmmSS, with seconds floored to the nearest 30 -- matches getTimestamp(offsetSeconds) exactly, including its local-time (not UTC) field extraction. */
export function computeStatsWindowKey(at: Date): string {
	const seconds = Math.floor(at.getSeconds() / 30) * 30;
	const pad2 = (n: number): string => String(n).padStart(2, '0');
	return (
		'wis2gc:stats:' +
		at.getFullYear() +
		pad2(at.getMonth() + 1) +
		pad2(at.getDate()) +
		pad2(at.getHours()) +
		pad2(at.getMinutes()) +
		pad2(seconds)
	);
}

/** Milliseconds from `at` until the next 30-second wall-clock boundary -- matches the original's `((30 - (seconds % 30)) * 1000) - ms` exactly. */
export function msUntilNextWindowBoundary(at: Date): number {
	const seconds = at.getSeconds();
	const ms = at.getMilliseconds();
	return (30 - (seconds % 30)) * 1000 - ms;
}
