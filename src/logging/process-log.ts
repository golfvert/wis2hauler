// Routes the plain `log.log/warn/error` calls (the `typeof console`
// every role runner and a few helpers receive) through a structured
// SourceLogger, so process/infrastructure messages obey exactly the
// same rules as every other log line: `global.log.to` picks the
// destination (stdout or file), the JSON line carries `logger`/`worker`/
// `timestamp`, and nothing bypasses the sink.
//
// Always written at the `info` level -- these are the lines an
// operator must never miss (aria2 unreachable, a role crashed, ...), and
// `info` is admitted at every configured level (logging/levels.ts). The
// original console method survives as the `severity` field
// (log -> "info", warn -> "warn", error -> "error") so a reader can still
// tell a routine "starting" line from a failure.
//
// An optional trailing plain object is merged into the line as extra
// structured fields (e.g. `{ data_id, topic }` on per-message failures)
// so those lines can be grouped by data_id like every other entry.
import type { SourceLogger } from './logger.ts';

export type Severity = 'info' | 'warn' | 'error';

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

export function createProcessLog(logger: SourceLogger): typeof console {
	const emit = (severity: Severity) => (...args: unknown[]): void => {
		const last = args[args.length - 1];
		const fields = isPlainObject(last) ? last : {};
		const textArgs = isPlainObject(last) ? args.slice(0, -1) : args;
		const message = textArgs.map((a) => (typeof a === 'string' ? a : a instanceof Error ? (a.stack ?? a.message) : String(a))).join(' ');
		logger.info({ ...fields, severity, message });
	};
	return { log: emit('info'), info: emit('info'), debug: emit('info'), warn: emit('warn'), error: emit('error') } as unknown as typeof console;
}
