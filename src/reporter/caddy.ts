// The Reporter tab's Caddy webhook chain: "Caddy" http-in (POST
// /caddy) -> "Reporter ?" gate (0acb04c88a3ca878 -- NOTE: gated on
// plain "reporter" role-active, NOT "reporter-primary"; every
// reporter-carrying replica processes every Caddy hit, matching the
// original exactly, not just whichever replica currently holds the
// election) -> "Country" (8af6da8799fee66d, GeoIP lookup) -> HGETALL
// infoGranuleKey(uri) (64c28b318eb1211c) -> "Extract" (59231387f2e450aa)
// -> fan-out to "Files"/"Bytes"/"Redis"+Lua (d49d5d0db1ceda24 /
// 41a443e0e3322f5b / 0f4ed7b62cf4aba1+b4b62b2a4c6e6e27).
//
// Caddy's log-webhook body shape (`msg.payload[0].client_ip` /
// `.uri`) has no defensive checks in the original -- a malformed body
// would throw inside the function node. parseCaddyLogEntry() below
// returns null instead of throwing for the same malformed-input case,
// so run.ts can log and drop the request rather than crash the HTTP
// handler; the practical effect (this one request's metrics are not
// recorded) matches the original's uncaught-exception outcome.
export interface CaddyLogEntry {
	clientIp: string;
	uri: string;
}

export function parseCaddyLogEntry(body: unknown): CaddyLogEntry | null {
	if (!Array.isArray(body) || body.length === 0) return null;
	const first = body[0] as Record<string, unknown> | undefined;
	if (!first || typeof first !== 'object') return null;
	const clientIp = first.client_ip;
	const uri = first.uri;
	if (typeof clientIp !== 'string' || typeof uri !== 'string') return null;
	return { clientIp, uri };
}

/** `msg.country = geo ? geo.country : "zz"` -- geo is whatever geoip-lite's lookup() returned (or null for no match), injected by the caller so this stays a pure mapping. */
export function deriveCountry(geo: { country: string } | null): string {
	return geo ? geo.country : 'zz';
}

/** The "Extract" change node's flat-array -> object parse, then its 3 picked fields (length/centreid/topic) -- the info-granule hash written by finishing.ts's recordInfoGranule(). */
export interface GranuleRecord {
	length: string | undefined;
	centreid: string | undefined;
	topic: string | undefined;
}

export function extractGranuleRecord(flatPayload: readonly unknown[]): GranuleRecord {
	const raw: Record<string, unknown> = {};
	for (let i = 0; i < flatPayload.length; i += 2) {
		raw[String(flatPayload[i])] = flatPayload[i + 1];
	}
	return {
		length: typeof raw.length === 'string' ? raw.length : undefined,
		centreid: typeof raw.centreid === 'string' ? raw.centreid : undefined,
		topic: typeof raw.topic === 'string' ? raw.topic : undefined,
	};
}

export interface MetricOp {
	op: 'inc' | 'set';
	labels: Record<string, string>;
	val: number;
}

function caddyLabels(granule: GranuleRecord, country: string, reportBy: string): Record<string, string> {
	return { centre_id: granule.centreid ?? '', topic: granule.topic ?? '', user_country: country, report_by: reportBy };
}

/** "Files" change node (d49d5d0db1ceda24): wmo_wis2_gc_user_downloaded_files_total, inc 1. */
export function buildFilesOp(granule: GranuleRecord, country: string, reportBy: string): MetricOp {
	return { op: 'inc', labels: caddyLabels(granule, country, reportBy), val: 1 };
}

/** "Bytes" change node (41a443e0e3322f5b): wmo_wis2_gc_user_downloaded_bytes_total, inc $number(length) -- NaN (not 0) if length is missing/non-numeric, matching JSONata's $number() on an unparseable string, ported as Number(...) unmodified. */
export function buildBytesOp(granule: GranuleRecord, country: string, reportBy: string): MetricOp {
	return { op: 'inc', labels: caddyLabels(granule, country, reportBy), val: Number(granule.length) };
}

/** "IPs" change node (e2409b6a91105fbf): wmo_wis2_gc_user_distinct_total, set to the Lua script's ZCARD result (distinctCount) -- see active-ips.ts for the script itself. */
export function buildIpsOp(granule: GranuleRecord, country: string, reportBy: string, distinctCount: number): MetricOp {
	return { op: 'set', labels: caddyLabels(granule, country, reportBy), val: distinctCount };
}
