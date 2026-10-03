#!/usr/bin/env bun
// scripts/bump-version.ts -- NOT part of wis2hauler itself (nothing under
// src/ imports this, so it is never pulled into the compiled binary). It
// maintains a VERSION file that a job in .github/workflows/release.yml
// reads to know what tag to publish a GitHub Release (and, for the
// repo-root VERSION specifically, the ghcr.io Docker image) under. It
// also writes the same tag into the "version" field of the package.json
// sitting next to that VERSION file, so the two never drift.
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
// Tag format: YYYY.M.X
//   YYYY = calendar year, M = calendar month (1-12, NO leading zero, so
//   the tag is valid semver), X = the Nth
//   release cut in that calendar month, starting at 1 and incrementing
//   by one on every run within the same month. Rolling into a new month
//   (or year) resets X back to 1. "Current month" is read from the
//   machine running this script (UTC), not from the file's own history.
//   (release.yml prefixes Tracer's tag with "tracer-" itself when it
//   reads Tracer/VERSION -- this script always writes the bare
//   YYYY.M.X form, the same for either file.)
//
// This is a MANUAL step, deliberately not run by CI: run it yourself,
// from the repo root, whenever you're ready to cut a new release --
//
//   bun scripts/bump-version.ts [path-to-VERSION-file]
//
// -- then commit the updated files (VERSION and package.json) and push.
// The push is what triggers the release workflow, which reads the new
// tag straight out of VERSION; running this script alone changes nothing
// until you push.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TARGET = process.argv[2] ?? 'VERSION';
const VERSION_FILE = join(import.meta.dir, '..', TARGET);
const PACKAGE_FILE = join(dirname(VERSION_FILE), 'package.json');
const TAG_PATTERN = /^(\d{4})\.([1-9]|1[0-2])\.(\d+)$/;

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
	return `${year}.${month}.${seq}`;
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

// Matches the first "version" line only -- the top-level field in both
// package.json files. A targeted replace (rather than JSON.parse +
// stringify) leaves the rest of the file's formatting untouched.
const PACKAGE_VERSION_PATTERN = /^(\s*"version"\s*:\s*")[^"]*(")/m;

function withPackageVersion(tag: string): string {
	if (!existsSync(PACKAGE_FILE)) throw new Error(`${PACKAGE_FILE} not found`);
	const raw = readFileSync(PACKAGE_FILE, 'utf-8');
	if (!PACKAGE_VERSION_PATTERN.test(raw)) throw new Error(`${PACKAGE_FILE} has no "version" field`);
	return raw.replace(PACKAGE_VERSION_PATTERN, `$1${tag}$2`);
}

const tag = nextTag(new Date());
// Build the package.json content first: if it can't be updated, fail
// before writing anything, so VERSION and package.json never disagree.
const packageJson = withPackageVersion(tag);
writeFileSync(VERSION_FILE, `${tag}\n`, 'utf-8');
writeFileSync(PACKAGE_FILE, packageJson, 'utf-8');
console.log(tag);
