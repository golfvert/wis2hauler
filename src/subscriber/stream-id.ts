// Pure comparison of two Redis Stream entry IDs ("<ms>-<seq>", e.g.
// "1790001872340-0"), backing runConsumerLoop's raw-stream lag
// detection (see that function's own doc comment, consumer.ts) --
// specifically, telling whether the stream's current OLDEST surviving
// entry is newer than the consumer's own read cursor (lastId), i.e.
// whether the region between them existed and was trimmed away by
// XADD's MAXLEN (ioredis-store.ts's RAW_STREAM_MAXLEN) before the
// consumer ever read it.
//
// Plain string/lexicographic comparison is NOT safe for this: IDs are
// two separate numbers joined by a dash, and e.g. "9-0" sorts AFTER
// "10-0" lexicographically even though 9 < 10 numerically. In
// practice every ID this codebase ever generates has a 13-digit
// millisecond half (real wall-clock epoch millis, XADD's own `*`), so
// that specific collision can't happen between two IDs this system
// produced -- but the sequence half (after the dash) genuinely CAN
// differ at an equal millisecond under high throughput, and is worth
// comparing correctly rather than leaning on the coincidence above.
export function compareStreamIds(a: string, b: string): number {
	const [aMs, aSeq] = parseStreamId(a);
	const [bMs, bSeq] = parseStreamId(b);
	if (aMs !== bMs) return aMs < bMs ? -1 : 1;
	if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
	return 0;
}

// "0-0" (runConsumerLoop's own startId default) and any real XADD-
// generated id ("<ms>-<seq>") both parse cleanly; a malformed/empty
// half falls back to 0 rather than throwing -- this function backs a
// health check, not a control-flow decision, so a bad ID should
// degrade to "treat as equal/oldest" rather than crash the consumer
// loop.
function parseStreamId(id: string): [number, number] {
	const [ms, seq] = id.split('-');
	return [Number(ms) || 0, Number(seq) || 0];
}

// Computes the Stream ID that is `marginMs` milliseconds BEFORE `id`,
// clamped at "0-0" rather than going negative -- backs runConsumerLoop's
// periodic MINID trim (added 2026-09-21, replacing the original
// count-only MAXLEN approach; see that function's own doc comment).
// Everything strictly older than this cutoff is safe to discard: by
// definition of the margin, the consumer (whose own read cursor is
// `id`, i.e. lastId) is guaranteed to already be at least `marginMs`
// ahead of it, so trimming there can never remove something still
// needed. The margin itself (15 minutes, run.ts) was sized against
// WIS2's own Global Cache SLA -- the maintainer: "A Global Cache must
// cache within 10 minutes to be OK" -- so 15 minutes stays strictly
// inside that window's own tolerance rather than being an arbitrary
// round number.
export function streamIdMinusMs(id: string, marginMs: number): string {
	const [ms] = parseStreamId(id);
	const cutoffMs = Math.max(0, ms - marginMs);
	return `${cutoffMs}-0`;
}
