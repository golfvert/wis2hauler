# Architecture decision records

One file per decision: context, options considered (including rejected ones), decision, consequences. Never rewrite history: if a decision changes, write a new ADR and mark the old one `superseded by NNNN`.

Statuses: `proposed`, `accepted`, `rejected`, `deferred`, `superseded`.

ADRs 0001-0011 were reconstructed on 2026-10-25 from working notes and git history, not written when the decisions were made. Dates are when the decision was made; commit hashes were checked against `git log`.

Copy `template.md` for a new one; number sequentially.

| # | Title | Status |
|---|---|---|
| 0001 | Record decisions as ADRs | accepted |
| 0002 | Weighted source selection replaces `priority-global-cache` | accepted |
| 0003 | Non-blocking consumer loop and hard cap on delay | accepted |
| 0004 | Raw stream trim: MINID primary, MAXLEN backstop | accepted |
| 0005 | No multi-key Lua without a shared hash tag | rejected (as implemented) |
| 0006 | `data_id` tracing, gated by `log.level` | accepted |
| 0007 | Reject a single-source dedicated DOWNLOADER | rejected |
| 0008 | Second DOWNLOADER; keep aria2 concurrency at 60; defer connection semaphore | accepted / deferred |
| 0009 | Default log level `info`, per-role runtime override | accepted |
| 0010 | Reject GB1/GB2 split as a CPU fix | rejected (later reused for another reason) |
| 0011 | Version scheme `YYYY.M.X`, Tracer released separately | accepted |
| 0012 | Rename `whitelist` / `blacklist` to `subscribe` / `exclude` | accepted |
