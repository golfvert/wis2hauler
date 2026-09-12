#!/usr/bin/env bun
// scripts/bump-version.ts -- NOT part of wis2hauler itself (nothing under
// src/ imports this, so it is never pulled into the compiled binary). It
// only maintains the repo-root VERSION file, which is the single source
// of truth .github/workflows/release.yml reads to know what tag to
// publish the GitHub Release and the ghcr.io Docker image under.
//
// Tag format: YYYY.MM.X
//   YYYY = calendar year, MM = calendar month (2 digits), X = the Nth
//   release cut in that calendar month, starting at 1 and incrementing
//   by one on every run within the same month. Rolling into a new month
//   (or year) resets X back to 1. "Current month" is read from the
//   machine running this script (UTC), not from the file's own history.
//
// This is a MANUAL step, deliberately not run by CI: run it yourself,
// from the repo root, whenever you're ready to cut a new release --
//
//   bun scripts/bump-version.ts
//
// -- then commit the updated VERSION file and push. The push is what
// triggers the release workflow, which reads the new tag straight out
// of VERSION; running this script alone changes nothing until you push.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_FILE = join(import.meta.dir, '..', 'VERSION');
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
