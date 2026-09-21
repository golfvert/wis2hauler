#!/usr/bin/env bun
// CLI entry point. Usage, running from source:
//
//   bun run src/trace.ts <data_id-or-wnm-id> [--root <dir>] [--since <time>] [--until <time>] [--json]
//
// -- or, as the standalone `wis2hauler-tracer` binary this compiles to
// (.github/workflows/release.yml's build-tracer job, `bun build
// --compile`), just `wis2hauler-tracer <data_id-or-wnm-id> [options]`
// directly, no bun install required on the machine running it -- see
// USAGE below, which reflects whichever way it's actually invoked.
//
// See README.md for the full walkthrough. Short version: point --root at
// wherever this deployment's worker directories (each with its own
// logs/) live, paste in whatever id you're chasing (a `dataId` or a
// `wnmId` -- this tool doesn't need to know which, it searches for the
// string wherever it appears), and it prints every matching log line
// across every hauler-*.log[.gz] file under that root, in chronological
// order, one line per hit.
import { basename } from 'node:path';
import { parseLogFilename, parseFilenameBucketMs, matchesInFile, walkLogFiles, type TraceMatch } from './logs.ts';
import { describeSource } from './sources.ts';

interface Options {
	needle: string;
	root: string;
	sinceMs: number | undefined;
	untilMs: number | undefined;
	json: boolean;
}

// Shows the USAGE line that matches how this was actually invoked --
// `bun run src/trace.ts` from source, or the real binary name when
// running as the compiled `wis2hauler-tracer` (see this file's header).
// `process.argv[1]` is the script path when run from source (its
// basename is literally "trace.ts") and the executable's own path when
// running as a `bun build --compile`d binary.
const programName = (() => {
	const invoked = process.argv[1];
	if (invoked === undefined) return 'wis2hauler-tracer';
	const base = basename(invoked);
	return base === 'trace.ts' ? 'bun run src/trace.ts' : base;
})();

const USAGE = `Usage: ${programName} <data_id-or-wnm-id> [options]

Options:
  --root <dir>     Directory to scan (default: current directory). Point this
                    at the parent of every worker's logs/ directory, or at a
                    single logs/ directory directly -- both work, the scan is
                    recursive.
  --since <time>    Only consider log lines timestamped at/after this time
                    (anything Date can parse, e.g. 2026-09-20T15:00:00Z).
  --until <time>    Only consider log lines timestamped at/before this time.
  --json            Print the raw matches as a JSON array instead of the
                    human-readable narrative.
  -h, --help        Show this message.`;

// Generous padding around --since/--until for the file-level prefilter
// ONLY (skip whole files before opening them) -- see logs.ts's
// parseFilenameBucketMs for why the file's own hour bucket can't be
// trusted precisely (it may not be UTC). 26h comfortably covers every
// real-world UTC offset (-12..+14) with margin either side of midnight.
// The actual since/until bound is still enforced exactly, per line,
// against that line's own UTC timestamp field in matchesInFile.
const PREFILTER_PAD_MS = 26 * 60 * 60 * 1000;

function parseTimeArg(flag: string, value: string): number {
	const ms = Date.parse(value);
	if (Number.isNaN(ms)) throw new Error(`${flag}: could not parse "${value}" as a date/time`);
	return ms;
}

function parseArgs(argv: string[]): Options {
	let needle: string | undefined;
	let root = '.';
	let sinceMs: number | undefined;
	let untilMs: number | undefined;
	let json = false;

	const nextValue = (i: number, flag: string): string => {
		const value = argv[i];
		if (value === undefined) throw new Error(`${flag} needs a value`);
		return value;
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		switch (arg) {
			case '-h':
			case '--help':
				console.log(USAGE);
				process.exit(0);
				break;
			case '--root':
				root = nextValue(++i, '--root');
				break;
			case '--since':
				sinceMs = parseTimeArg('--since', nextValue(++i, '--since'));
				break;
			case '--until':
				untilMs = parseTimeArg('--until', nextValue(++i, '--until'));
				break;
			case '--json':
				json = true;
				break;
			default:
				if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
				if (needle !== undefined) throw new Error(`unexpected extra argument: ${arg} (needle already set to "${needle}")`);
				needle = arg;
		}
	}

	if (needle === undefined || needle.length === 0) {
		console.log(USAGE);
		throw new Error('missing required argument: the data_id or wnm.id to trace');
	}
	return { needle, root, sinceMs, untilMs, json };
}

function formatLine(match: TraceMatch): string {
	const meta = describeSource(match.source);
	const when = match.timestamp ?? '(no timestamp)';
	return `[${when}] ${meta.role.padEnd(10)} ${meta.name.padEnd(20)} ${match.level.padEnd(5)} ${JSON.stringify(match.data)}`;
}

async function collectMatches(opts: Options): Promise<{ matches: TraceMatch[]; filesScanned: number; filesMatched: number }> {
	const prefilterSince = opts.sinceMs !== undefined ? opts.sinceMs - PREFILTER_PAD_MS : undefined;
	const prefilterUntil = opts.untilMs !== undefined ? opts.untilMs + PREFILTER_PAD_MS : undefined;

	const matches: TraceMatch[] = [];
	let filesScanned = 0;
	let filesMatched = 0;

	for await (const file of walkLogFiles(opts.root)) {
		const filename = file.slice(file.lastIndexOf('/') + 1);
		const parsed = parseLogFilename(filename);
		if (!parsed) continue; // walkLogFiles already filters on this, but keep this function self-contained

		if (prefilterSince !== undefined || prefilterUntil !== undefined) {
			const bucketMs = parseFilenameBucketMs(parsed.dateHour);
			if (!Number.isNaN(bucketMs)) {
				// The bucket is the START of that hour -- an hour's worth of
				// lines can fall anywhere in [bucketMs, bucketMs + 1h), so widen
				// the file's own effective end by one hour before comparing.
				if (prefilterUntil !== undefined && bucketMs > prefilterUntil) continue;
				if (prefilterSince !== undefined && bucketMs + 60 * 60 * 1000 < prefilterSince) continue;
			}
		}

		filesScanned++;
		let matchedInThisFile = 0;
		for await (const match of matchesInFile(file, parsed, opts.needle, opts.sinceMs, opts.untilMs)) {
			matches.push(match);
			matchedInThisFile++;
		}
		if (matchedInThisFile > 0) filesMatched++;
	}

	return { matches, filesScanned, filesMatched };
}

async function main(): Promise<void> {
	const opts = parseArgs(process.argv.slice(2));
	const { matches, filesScanned, filesMatched } = await collectMatches(opts);

	// Chronological order is the whole point -- ISO-8601 UTC strings sort
	// lexicographically the same as chronologically. Matches with no
	// timestamp (only the rare non-JSON fallback line) sort last, grouped
	// together, rather than interleaved arbitrarily.
	matches.sort((a, b) => {
		if (a.timestamp === undefined && b.timestamp === undefined) return 0;
		if (a.timestamp === undefined) return 1;
		if (b.timestamp === undefined) return -1;
		return a.timestamp.localeCompare(b.timestamp);
	});

	if (opts.json) {
		console.log(JSON.stringify(matches, null, 2));
		return;
	}

	if (matches.length === 0) {
		console.log(`No trace found for "${opts.needle}" (${filesScanned} log file(s) scanned under ${opts.root}).`);
		console.log('');
		console.log('If this id should exist, check: is global.log.level actually "debug" for the relevant role (Received/Filter/Decision/Aria/Ack/... are all gated by it); is the SUBSCRIBER container\'s mqtt.whitelist actually subscribed to the topic this centre/content would arrive on; and is --root really pointing at where this deployment writes its logs/ directories.');
		return;
	}

	console.log(`${matches.length} matching log line(s) for "${opts.needle}" -- ${filesMatched}/${filesScanned} file(s) scanned had a hit:\n`);
	for (const match of matches) console.log(formatLine(match));

	const first = matches[0] as TraceMatch;
	const last = matches[matches.length - 1] as TraceMatch;
	console.log('');
	console.log(`First seen: ${describeSource(first.source).name} at ${first.timestamp ?? '(no timestamp)'}`);
	console.log(`Last seen:  ${describeSource(last.source).name} at ${last.timestamp ?? '(no timestamp)'} -- ${describeSource(last.source).stage}`);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
