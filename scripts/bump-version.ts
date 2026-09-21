#!/usr/bin/env bun
// scripts/bump-version.ts -- NOT part of wis2hauler itself (nothing under
// src/ imports this, so it is never pulled into the compiled binary). It
// maintains a VERSION file that a job in .github/workflows/release.yml
// reads to know what tag to publish a GitHub Release (and, for the
// repo-root VERSION specifically, the ghcr.io Docker image) under.
//
// Two independent version files use this same script and format:
//   VERSION          -- the main wis2hauler binaries + Docker image
//   Tracer/VERSION   -- the standalone wis2hauler-tracer CLI (Tracer/)
// They are bumped separately and on their own schedule -- see
// release.yml's header comment for why Tracer is decoupled from the
// main app's release cadence. Default (no argument) bumps the
// repo-root VERSION; pass a path to bump a different one:
//
//   bun scripts/bump-version.ts                  # main wis2hauler
//   bun scripts/bump-version.ts Tracer/VERSION    # wis2hauler-tracer
//
// Tag format: YYYY.MM.X
//   YYYY = calendar year, MM = calendar month (2 digits), X = the Nth
//   release cut in that calendar month, starting at 1 and incrementing
//   by one on every run within the same month. Rolling into a new month
//   (or year) resets X back to 1. "Current month" is read from the
//   machine running this script (UTC), not from the file's own history.
//   (release.yml prefixes Tracer's tag with "tracer-" itself when it
//   reads Tracer/VERSION -- this script always writes the bare
//   YYYY.MM.X form, the same for either file.)
//
// This is a MANUAL step, deliberately not run by CI: run it yourself,
// from the repo root, whenever you're ready to cut a new release --
//
//   bun scripts/bump-version.ts [path-to-VERSION-file]
//
// -- then commit the updated file and push. The push is what triggers
// the release workflow, which reads the new tag straight out of the
// file; running this script alone changes nothing until you push.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TARGET = process.argv[2] ?? 'VERSION';
const VERSION_FILE = join(import.meta.dir, '..', TARGET);
const TAG_PATTERN = /^(\d{4})\.(\d{2})\.(\d+)$/;

interface ParsedTag {
	year: number;
	month: number;
	seq: number;
}

function parseTag(raw: string): ParsedTag | null {
	const match = TAG_PATTERN.exec(raw.trim());
	if (!match) return null;
	return { year: Number(match[1]), month: Number(match[2]), seq: Number(match[3]) };
}

function formatTag(year: number, month: number, seq: number): string {
	return `${year}.${String(month).padStart(2, '0')}.${seq}`;
}

function readCurrentTag(): ParsedTag | null {
	if (!existsSync(VERSION_FILE)) return null;
	const raw = readFileSync(VERSION_FILE, 'utf-8');
	return raw.trim() ? parseTag(raw) : null;
}

function nextTag(now: Date): string {
	const year = now.getUTCFullYear();
	const month = now.getUTCMonth() + 1;

	const current = readCurrentTag();
	// Same calendar month as the last release cut -- keep counting up.
	// Anything else (no file yet, unparsable content, or a new month/year)
	// starts a fresh count at 1 rather than guessing at intent.
	const seq = current && current.year === year && current.month === month ? current.seq + 1 : 1;

	return formatTag(year, month, seq);
}

const tag = nextTag(new Date());
writeFileSync(VERSION_FILE, `${tag}\n`, 'utf-8');
console.log(tag);
