// Derives the content-based "downloader_id" used to dedup a data
// granule across every path it might arrive by (the true origin, plus
// zero or more Global Cache repeaters) — this is the key the claim
// race in dedup.ts operates on, distinct from the earlier
// per-raw-message dedup keyed by the WNM's own `id` (see the
// Save/SETNX step in the MQTT-ingest stage). Ported from the
// Node-RED "downloader_id" change node (Subscriber tab).
import type { Wnm } from '../wis2/wnm.ts';

export function computeDownloaderId(wnm: Wnm): string {
	const integrityValue = wnm.properties.integrity?.value;
	const uniqueId =
		integrityValue != null
			? String(integrityValue).replaceAll('/', '').slice(0, 12)
			: wnm.properties.pubtime.replace(/[^0-9]/g, '');
	return `${wnm.properties.data_id}:${wnm.properties.pubtime}:${uniqueId}`;
}
