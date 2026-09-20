// Port of the "Decode & Write" function node (Downloader tab, id
// d76ede1139dcd464): the embedded-content fast path. When a work-queue
// entry's `content` flag is "true" (Subscriber's enqueueWork stamped
// it because wnm.properties.content was present), this is tried BEFORE
// ever registering a real aria2 download -- it decodes the content
// inline and writes it straight to disk, minting a synthetic gid in
// the same shape a real aria2 gid would have.
//
// Two outcomes, exactly like the original's two-output function node:
//   - 'written': content decoded, integrity check (if any) passed, file
//     written to downloader['aria-download'] (see the ariaDownloadDir
//     parameter below). The caller registers this synthetic gid's
//     aria2_gid record (store.setAria2GidFields with the SAME 5-field
//     shape aria-start.ts's real path writes) and proceeds directly
//     into ack.ts's startAck() + complete.ts's runComplete() -- this
//     fast path never touches streamIdKey, never calls
//     scheduleCleanerCancel (there's no real in-flight aria2 download
//     for a cancel safety-net to apply to), and never goes through
//     StartAck's normal HGETALL(aria2GidKey) fetch dance since the
//     caller already has every field in hand.
//   - 'fallback': content missing, integrity mismatch, or any other
//     processing error (JSON.parse, fs errors, an unsupported/garbled
//     encoding -- ALL of it, since the original wraps the entire body
//     in one try/catch, unlike hash.ts's date/topic-rename path which
//     escapes its own try/catch by throwing during Promise-argument
//     evaluation; there's no such timing quirk here, it's a literal,
//     ordinary try/catch in the source). The caller falls through to
//     aria-start.ts's startRealDownload() for this href, exactly as if
//     `content` had been "false" to begin with (confirmed against
//     flows.json: this function's fallback output and the real
//     "Content ?" false branch both feed the same "Aria" change node,
//     via link-in 13, id 3245ad0eb0dabc05).
export type DecodeWriteOutcome = { kind: 'fallback' } | { kind: 'written'; gid: string; filename: string; filepath: string };

export interface DecodeWriteEntry {
	/** The work-queue stream entry id (msg.downloads.id in the original) -- the first component of the synthetic gid. */
	id: string;
	downloaderId: string;
	href: string;
	/** WorkQueueEntry.dataId, threaded through purely for the io.warn() messages below and the aria2_gid record this path registers -- see store.ts's doc comment. '' when the original message had none. NOT a port (2026-09-20). */
	dataId: string;
}

export interface DecodeWriteIO {
	mkdirRecursive(dir: string): void;
	join(...parts: string[]): string;
	dirname(filepath: string): string;
	writeFileSync(filepath: string, data: Uint8Array): void;
	gunzipSync(data: Uint8Array): Uint8Array;
	base64Decode(value: string): Uint8Array;
	utf8Encode(value: string): Uint8Array;
	/** crypto.createHash(method).update(buffer).digest('base64') -- synchronous, matching the original (there is no stream here, the whole buffer is already in memory). */
	hashBase64(method: string, data: Uint8Array): string;
	/** Math.floor(Math.random() * 1000000), stringified -- the second half of the synthetic gid. */
	randomStreamSuffix(): string;
	warn(message: string): void;
}

interface EmbeddedWnm {
	properties?: {
		content?: { encoding?: string; value?: string };
		integrity?: { value?: string; method?: string };
	};
}

export function runDecodeWrite(entry: DecodeWriteEntry, wnmJson: string, ariaDownloadDir: string, io: DecodeWriteIO): DecodeWriteOutcome {
	try {
		const wnm = JSON.parse(wnmJson) as EmbeddedWnm;
		const content = wnm.properties?.content;
		if (!content) {
			io.warn(`Content flag set but properties.content is missing, falling back to href: ${entry.id} (data_id ${entry.dataId || '(none)'})`);
			return { kind: 'fallback' };
		}

		let buffer: Uint8Array;
		switch (content.encoding) {
			case 'base64':
				buffer = io.base64Decode(content.value ?? '');
				break;
			case 'gzip':
				buffer = io.gunzipSync(io.base64Decode(content.value ?? ''));
				break;
			default: // 'utf-8'
				buffer = io.utf8Encode(content.value ?? '');
		}

		const integrity = wnm.properties?.integrity;
		if (integrity && integrity.value) {
			const digest = io.hashBase64(integrity.method ?? '', buffer);
			if (digest !== integrity.value) {
				io.warn(`Embedded content failed integrity check, falling back to href: ${entry.id} (data_id ${entry.dataId || '(none)'})`);
				return { kind: 'fallback' };
			}
		}

		// Only past this point does the original touch disk -- ported at the same point.
		// ariaDownloadDir is downloader['aria-download'] -- the SAME
		// directory aria2 itself writes into (aria2.conf's dir=), so this
		// fast path and the real-aria2 path can never write to two
		// different places. See schema.ts's doc comment on the field.
		const ariaDir = ariaDownloadDir;
		// gid minted here (not after the write) so its already-unique
		// value (entry.id + a random suffix -- same shape as
		// aria-start.ts's streamId) can also disambiguate the filename.
		// NOT a port -- the original (and this port until 2026-09-19) built
		// the filename from `${downloaderId's content-derived tail}_${href's
		// basename}` alone, which two DIFFERENT WNMs can collide on (see
		// aria-start.ts's matching comment for exactly why), and this
		// function -- unlike aria2 -- has never checked for an existing
		// file at all: writeFileSync just truncates and overwrites
		// whatever's already there. Folding the synthetic gid into the
		// filename removes the collision at the source instead. Per the
		// maintainer, 2026-09-19: "avoid collision in aria2, in rename and
		// in content" -- this is the content half; see aria-start.ts
		// (aria2) and hash.ts (rename) for the other two.
		const gid = `${entry.id}-${io.randomStreamSuffix()}`;
		const filename = `${gid}_${entry.href.split('/').pop()}`;
		const filepath = io.join(ariaDir, filename);
		io.mkdirRecursive(io.dirname(filepath));
		io.writeFileSync(filepath, buffer);

		return { kind: 'written', gid, filename, filepath };
	} catch (err) {
		io.warn(`Embedded content processing error, falling back to href (${entry.id}, data_id ${entry.dataId || '(none)'}): ${err instanceof Error ? err.message : String(err)}`);
		return { kind: 'fallback' };
	}
}
