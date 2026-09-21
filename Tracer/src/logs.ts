// File discovery, line reading, and matching for Hauler's own log files.
//
// Every Hauler log line is one JSON object per line, written by
// src/logging/sink.ts's WinstonLogSink to a file named
// wis2gc-<slug>-<date-hour>.<level>.log, gzip-archived on rotation
// (wis2gc-<slug>-<date-hour>.<level>.log.gz). <slug> is
// slugifySource(name) -- lowercase, [^a-z] stripped -- see sources.ts's
// own header for how that maps back to a human-readable logger name.
//
// A HIGH-VOLUME logger (Filter, which carries the full WNM on every
// single message -- easily 20MB+/hour on a busy feed) can blow past
// winston-daily-rotate-file's own `maxSize` more than once within the
// SAME hour bucket. When that happens it rotates again immediately,
// appending a small integer before the .gz:
// wis2gc-filter-<date-hour>.debug.log.gz (oldest chunk of that hour),
// .log.1.gz, .log.2.gz, ... (each subsequent chunk), found live in
// production 2026-09-21 -- a low-volume logger like Decision never
// generates one, but Filter routinely has 2-3 per hour. FILENAME_RE
// below accounts for this explicitly (see its own inline comment);
// forgetting it would silently make every chunk but the newest
// invisible to every trace, with no error or warning anywhere -- which
// is exactly what happened before this was added.
//
// This module deliberately does NOT hardcode which JSON field a data_id
// or wnm.id lives under for a given source (dataId, wnmId, wnm.id,
// wnm.properties.data_id, nested inside a "wnm"/"monitor" object on
// Publish, embedded in an error string, ...). Hauler's own logging shape
// has changed several times in a single day this session (see its
// docs/configuration-and-roles.md) -- hardcoding field paths here would
// make this tool stale the next time that happens. Instead, valueContains
// below walks the WHOLE parsed object looking for the id as a substring
// of any string value, wherever it lives. This is the same principle as
// the shell-based runbook this tool replaces (`zgrep -h
// "\"downloaderId\":\"$id\""`), just correct regardless of which key the
// id sits under.
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { join } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'debug';

export interface ParsedLogFilename {
	slug: string;
	/** "YYYY-MM-DD-HH", exactly as winston-daily-rotate-file's fileDatePattern wrote it. Not guaranteed to be UTC -- see parseFilenameBucketMs's own doc comment. */
	dateHour: string;
	level: LogLevel;
	/** winston-daily-rotate-file's own within-the-same-hour rotation index ("...log.1.gz", "...log.2.gz", ...), when `maxSize` forced more than one rotation inside one hour bucket -- see this file's header. `undefined` for the first/only chunk of that hour (plain "...log.gz" or the still-open "...log"). Purely informational: matching and chronological ordering never depend on it, since every line is sorted by its OWN `timestamp` field regardless of which chunk it came from. */
	rotation: number | undefined;
	gzip: boolean;
}

// The `(?:\.(\d+))?` group is what makes a same-hour rotation chunk
// ("...log.1.gz", "...log.2.gz", produced when a high-volume logger like
// Filter exceeds maxSize more than once inside one hour -- see this
// file's header) match at all; without it, every chunk but the first is
// silently invisible to walkLogFiles below, with no error anywhere.
const FILENAME_RE = /^wis2gc-([a-z]+)-(\d{4}-\d{2}-\d{2}-\d{2})\.(info|warn|debug)\.log(?:\.(\d+))?(\.gz)?$/;

export function parseLogFilename(filename: string): ParsedLogFilename | undefined {
	const m = FILENAME_RE.exec(filename);
	if (!m) return undefined;
	const [, slug, dateHour, level, rotation, gz] = m;
	return {
		slug: slug as string,
		dateHour: dateHour as string,
		level: level as LogLevel,
		rotation: rotation !== undefined ? Number(rotation) : undefined,
		gzip: gz !== undefined,
	};
}

// The file's own hour bucket is a coarse, best-effort ms timestamp for
// the --since/--until PREFILTER only (skip whole files before opening
// them) -- never for the final decision on whether a matched line is in
// range, which always uses that line's own `timestamp` field (always a
// real UTC ISO string, set unconditionally by sink.ts's write()).
// winston-daily-rotate-file's fileDatePattern is evaluated in the
// process's LOCAL time by default, not UTC, and this tool has no way to
// know what timezone a given deployment's host runs in -- so this parses
// the bucket AS IF it were UTC and the caller is expected to pad its
// window generously (see trace.ts's PREFILTER_PAD_MS) rather than trust
// this value precisely.
export function parseFilenameBucketMs(dateHour: string): number {
	// "YYYY-MM-DD-HH" -> "YYYY-MM-DDTHH:00:00Z"
	const m = /^(\d{4}-\d{2}-\d{2})-(\d{2})$/.exec(dateHour);
	if (!m) return NaN;
	const [, ymd, hh] = m;
	return Date.parse(`${ymd}T${hh}:00:00Z`);
}

// Recursively yields every wis2gc-*.<level>.log[.gz] file under `root`,
// however deep -- a production deployment's logs live under one `logs/`
// subdirectory per worker (worker/logs/wis2gc-....log), and `root` is
// typically the parent of all those worker directories (matching the
// existing shell runbook's `find */logs -name 'wis2gc-...'`), but this
// also works if `root` is a single logs/ dir directly. Symlinks are
// skipped (never followed) to avoid loops; dotfiles/dot-directories are
// skipped as a matter of hygiene (nothing Hauler writes starts with a
// dot).
export async function* walkLogFiles(root: string, isTop = true): AsyncGenerator<string> {
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch (err) {
		// The root the user actually asked to scan not existing/being
		// unreadable is a real, fatal misconfiguration -- surface it. A
		// nested subdirectory failing (permissions, a mid-rotation race) is
		// not worth aborting an otherwise-useful scan over -- warn and skip.
		const message = `cannot read directory ${root}: ${err instanceof Error ? err.message : String(err)}`;
		if (isTop) throw new Error(message);
		console.error(`wis2hauler-tracer: ${message} (skipping)`);
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		if (entry.isSymbolicLink()) continue;
		const full = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* walkLogFiles(full, false);
		} else if (entry.isFile() && parseLogFilename(entry.name)) {
			yield full;
		}
	}
}

// Deep, schema-agnostic substring search -- see this file's own header
// for why field paths are never hardcoded. Every string leaf anywhere in
// the parsed line is checked; objects/arrays are walked recursively.
export function valueContains(value: unknown, needle: string): boolean {
	if (typeof value === 'string') return value.includes(needle);
	if (Array.isArray(value)) return value.some((v) => valueContains(v, needle));
	if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some((v) => valueContains(v, needle));
	return false;
}

export interface TraceMatch {
	file: string;
	source: string; // the slug, e.g. "filter"
	level: LogLevel;
	/** This line's own `timestamp` field (UTC ISO), when the line parsed as JSON and had one. */
	timestamp: string | undefined;
	/** The parsed line, or `{ raw: <line> }` for the rare line that isn't valid JSON. */
	data: Record<string, unknown>;
}

function readLines(filePath: string, gzip: boolean): AsyncIterable<string> {
	const fileStream = createReadStream(filePath);
	const input = gzip ? fileStream.pipe(createGunzip()) : fileStream;
	return createInterface({ input, crlfDelay: Infinity });
}

// Scans one already-identified log file for lines whose parsed content
// contains `needle` anywhere (see valueContains), optionally bounded by
// [sinceMs, untilMs] against each line's OWN timestamp field (not the
// file's bucket -- see parseFilenameBucketMs). A line missing a usable
// timestamp is never dropped by the time window (there's nothing to
// compare), only lines with a timestamp outside it are.
export async function* matchesInFile(filePath: string, parsed: ParsedLogFilename, needle: string, sinceMs?: number, untilMs?: number): AsyncGenerator<TraceMatch> {
	for await (const line of readLines(filePath, parsed.gzip)) {
		if (line.length === 0) continue;

		let data: Record<string, unknown>;
		let timestamp: string | undefined;
		try {
			const value = JSON.parse(line) as unknown;
			if (typeof value !== 'object' || value === null) continue;
			data = value as Record<string, unknown>;
			if (!valueContains(data, needle)) continue;
			timestamp = typeof data.timestamp === 'string' ? data.timestamp : undefined;
		} catch {
			// Not valid JSON (truncated line at a rotation boundary, or a
			// stray non-Hauler line in the same directory) -- fall back to a
			// raw substring check so a genuine hit still surfaces, just
			// without structured fields or a timestamp to sort it precisely.
			if (!line.includes(needle)) continue;
			data = { raw: line };
			timestamp = undefined;
		}

		if (timestamp !== undefined) {
			const ms = Date.parse(timestamp);
			if (!Number.isNaN(ms)) {
				if (sinceMs !== undefined && ms < sinceMs) continue;
				if (untilMs !== undefined && ms > untilMs) continue;
			}
		}

		yield { file: filePath, source: parsed.slug, level: parsed.level, timestamp, data };
	}
}
