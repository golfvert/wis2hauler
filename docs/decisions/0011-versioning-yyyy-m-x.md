# 0011. Version scheme `YYYY.M.X`, Tracer released separately

- Status: accepted
- Date: 2026-09-21, amended 2026-10-03
- Related: commits d0baf52, 77d1a9b, 7228901; `scripts/bump-version.ts`

## Decision
Tags are `YYYY.M.X`: year, month without leading zero (so the tag is valid semver), and the Nth release in that month (resets monthly). `VERSION` and `package.json` are kept in sync by `bun scripts/bump-version.ts`. `Tracer/VERSION` is bumped separately and released independently by `.github/workflows/release.yml`.

## Consequences
Local git tags stop at `2026.09.17`, while `VERSION` is at 2026.10.1. Check whether CI creates the later tags; if not, tag releases so the changelog can link to them.
