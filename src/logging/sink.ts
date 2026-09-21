// The output half of the ported logIO mechanism: given a level and a
// (already-slugified) source name, write one JSON line to whichever
// destination `global.log.to` selects -- matching flows.json's
// "Log to ?" switches (df8805a947acb6a0 / 3c212723ddce7a68 /
// f82b44178ea8f71e), which route each level's pipeline to either the
// console (stdout) logger or the "File" logger, never both at once
// (the maintainer's explicit "no both" this session -- ../config/schema.ts's
// LogConfig stays a strict `to: 'stdout' | 'file'`, same as the
// original's own either/or switch). Originally modeled on the
// original's "Docker" console logger -- renamed to `'stdout'` per
// the maintainer's explicit request, since that's what it actually is: plain
// console output, not anything Docker-specific.
//
// File destination: one winston logger (with its own
// winston-daily-rotate-file transport) per (level, source) pair,
// created lazily and cached -- the original has one dedicated logIO-
// logger config node per level (Info/Warn/Debug), but a DYNAMIC
// filename per source (`_logIO_.fileName`, see slug.ts's header), so
// reproducing that here means one rotating file per source per level,
// not one per level.
//
// Rotation size/count: NOT per-level any more -- the original hardcodes
// three different values on its three file-logger config nodes
// (2e49a2f6bafded03 / df0bdc73ef5a1b7e / 3ad4ebabe71d57df: info/warn
// 200MB, debug 100MB, 25/26/26 max files), but per the maintainer's explicit
// request this session ("something hierarchical with level, to, size
// and number ... under a log: entry"), `global.log.size`/`.number` are
// now ONE configured size/count applied to every level uniformly, not
// three independently-tuned ones -- a deliberate simplification, not a
// faithful per-level port. `global.log.size` is a plain number of
// MEGABYTES (the maintainer: "For size just 200 (and make it default to be MB).
// 'm' for a size is pointless.") -- converted to winston-daily-rotate-
// file's own `"<n>m"` string form only at the point of use below, never
// exposed as a unit-suffixed value in config. Still gzip-archived,
// still dated YYYY-MM-DD-HH (hourly buckets, matching fileDatePattern).
// The WARN pipeline's dynamic filename bug (it built "...debug.log"
// instead of "...warn.log" -- see the session's logging analysis, node
// b4eda2dd5f255c3c vs. 244b379575d5653c/aefeea0d2c59acde) is NOT
// reproduced: every level here writes to its own correctly-named file
// (per the maintainer's explicit "Fix. I have fixed NR." -- they've corrected the
// same bug in the live Node-RED flow).
//
// Console (stdout) destination: matches the original's "Docker" loggers
// (consoleIsJsonFormat: true) -- one JSON line per call, level and
// source included as fields (there's no per-source *file* to name, so
// no rotation/transport-per-source needed there, and `size`/`number`
// are simply unused in this mode).
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import type { LogLevel } from '../config/runtime.ts';

export interface LogSink {
	write(level: LogLevel, source: string, data: Record<string, unknown>): void;
}

export type LogDestination = 'stdout' | 'file';

export interface WinstonSinkOptions {
	destination: LogDestination;
	/** Directory for file-mode rotation. Defaults to "./logs" (see config/schema.ts's LogConfig.dir doc comment -- the original hardcodes "/logs", a path specific to its Docker deployment). */
	logDir?: string;
	/** Max size per rotated file, in MEGABYTES (a plain number -- no unit suffix, see this file's header). Defaults to DEFAULT_MAX_SIZE_MB. Applied to every level uniformly -- see this file's header. */
	maxSize?: number;
	/** Max number of rotated files kept per (level, source). Defaults to DEFAULT_MAX_FILES. Applied to every level uniformly -- see this file's header. */
	maxFiles?: number;
}

const DEFAULT_LOG_DIR = './logs';
// Fallback when global.log.size/.number are unset -- the same baseline
// the original's info/warn file-loggers used (200MB/25 files), picked
// as the single uniform default now that size/count are no longer
// per-level. MB, plain number -- see this file's header.
const DEFAULT_MAX_SIZE_MB = 200;
const DEFAULT_MAX_FILES = 25;

export class WinstonLogSink implements LogSink {
	private readonly loggers = new Map<string, winston.Logger>();
	private readonly destination: LogDestination;
	private readonly logDir: string;
	private readonly maxSize: number;
	private readonly maxFiles: number;

	constructor(options: WinstonSinkOptions) {
		this.destination = options.destination;
		this.logDir = options.logDir ?? DEFAULT_LOG_DIR;
		this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE_MB;
		this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
	}

	private getLogger(level: LogLevel, source: string): winston.Logger {
		const key = `${level}:${source}`;
		const existing = this.loggers.get(key);
		if (existing) return existing;

		const transport =
			this.destination === 'file'
				? new DailyRotateFile({
						dirname: this.logDir,
						// hauler-<source>-%DATE%.<level>.log -- renamed 2026-09-21
						// from the original port's "wis2gc-" prefix (the maintainer:
						// "logs are still called wis2gc-xxxx which is coming from the
						// old name" -- wis2gc was this project's Node-RED-era name,
						// Hauler is this port's). This is a FILE-naming change only --
						// the "wis2gc:"-prefixed Redis KEY namespace (redis-keys.ts)
						// is a separate, deliberately unchanged concern, not touched
						// here. Tracer/src/logs.ts's FILENAME_RE accepts BOTH prefixes
						// (see that file's own comment) so already-rotated pre-rename
						// log files stay traceable after a deployment picks this up.
						filename: `hauler-${source}-%DATE%.${level}.log`,
						datePattern: 'YYYY-MM-DD-HH',
						zippedArchive: true,
						// winston-daily-rotate-file wants its own "<n>m" string form --
						// converted here, at the point of use, so the plain-MB-number
						// config value (see this file's header) never has to carry a
						// unit suffix.
						maxSize: `${this.maxSize}m`,
						maxFiles: String(this.maxFiles),
					})
				: new winston.transports.Console();

		// One logger per (level, source): its own configured `level` is
		// irrelevant to filtering here (levels.ts already decided whether
		// to call write() at all) -- it just needs to accept whichever
		// level winston.log() is called with below.
		const logger = winston.createLogger({
			level,
			format: winston.format.json(),
			transports: [transport],
		});
		this.loggers.set(key, logger);
		return logger;
	}

	write(level: LogLevel, source: string, data: Record<string, unknown>): void {
		// isTimestampUTC: true on every original logger -- toISOString() is always UTC.
		this.getLogger(level, source).log(level, { ...data, timestamp: new Date().toISOString() });
	}
}
