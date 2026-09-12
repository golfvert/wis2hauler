// Shared flat-array -> object parser. The Downloader tab re-implements
// this same 6-line loop as its own local "K/V" function node at every
// HGETALL call site that wants named-field access instead of scanning
// the flat array directly (9cefeb03721f1cf7 in StartAck, 346713c84d51ac47
// in the Error/Bad-Hash retry chain, and bc32ee46f1310103's "K/V + UUID"
// variant in the Complete chain, which is the same loop plus one extra
// `output.uuid = crypto.randomUUID()` line) -- centralized here instead
// of copy-pasted, since it's byte-for-byte the same transform every time.
// retry.ts's decideRetry() deliberately does NOT use this: it scans the
// flat array directly, exactly like the original's "Next" function node
// does, rather than going through an object first (see retry.ts's own
// header comment).
export function parseFlatRecord(flat: readonly string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (let i = 0; i < flat.length; i += 2) {
		const key = flat[i];
		if (key !== undefined) out[key] = flat[i + 1] ?? '';
	}
	return out;
}
