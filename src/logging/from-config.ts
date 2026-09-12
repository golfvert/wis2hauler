// Closes the last gap between config/schema.ts's LogConfig (the static
// `global.log` section) and a real, running LogSink. `level` was
// already wired end to end (admin/runtime-store.ts's RuntimeConfigStore
// seeds itself from `config.global.log.level` and implements
// LevelGate); `to`/`size`/`number`/`dir` were not -- config/validate.ts
// only ever reported their effective values in an info line, nothing
// turned them into a real WinstonSinkOptions. This file is that
// translation, kept as a small pure function (resolveSinkOptions)
// separate from sink construction itself, so the mapping -- what each
// config field means, what happens when it's omitted -- is
// unit-testable without spinning up real winston loggers, matching the
// project's usual pure-decision/real-I/O split.
import type { LogConfig } from '../config/schema.ts';
import { WinstonLogSink, type WinstonSinkOptions } from './sink.ts';
import type { LogSink } from './sink.ts';

/**
 * Maps a loaded `global.log` config section to WinstonLogSink's own
 * options shape. `to` stays the strict either/or LogConfig.to documents
 * (the maintainer: "no both") -- anything other than the literal `'file'`
 * (including `to` being unset) means stdout, matching
 * config/validate.ts's own `to ?? 'stdout'` default reporting.
 * `size`/`number`/`dir` pass straight through, `undefined` and all --
 * WinstonLogSink already knows its own defaults (200MB/25 files/
 * "./logs") for whichever of these the config left unset, so this
 * function doesn't need to duplicate them.
 */
export function resolveSinkOptions(log: LogConfig): WinstonSinkOptions {
	return {
		destination: log.to === 'file' ? 'file' : 'stdout',
		logDir: log.dir,
		maxSize: log.size,
		maxFiles: log.number,
	};
}

/** Builds the real sink a running process should log through, straight from the loaded static config's `global.log` section. */
export function createLogSinkFromConfig(log: LogConfig): LogSink {
	return new WinstonLogSink(resolveSinkOptions(log));
}
