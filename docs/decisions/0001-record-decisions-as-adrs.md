# 0001. Record decisions as ADRs

- Status: accepted
- Date: 2026-10-25

## Context
Until now, reasoning lived in local working notes (`notes/`, gitignored) and in session write-ups kept outside the repo. Git held the code and terse commit messages, so the "why" and the rejected options were not versioned.

## Decision
Keep one short ADR per significant decision in `docs/decisions/`, plus `CHANGELOG.md` and a root `AGENTS.md` with standing rules. The Maintainer decides; an AI coding agent (any tool) or a human drafts and implements.

## Consequences
Rejected options are recorded so they are not re-proposed. ADRs 0002-0011 are reconstructed after the fact and say so.
