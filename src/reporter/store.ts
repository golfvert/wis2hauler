// The Redis-backed persistence the Reporter pipeline needs, behind one
// narrow interface -- same split as ../downloader/store.ts and
// ../cleaner/store.ts. Every method corresponds to specific Node-RED
// nodes on the Reporter tab of nodered/flows.json (tab id
// 5ff6c20513455391), traced node-by-node this session -- ids cited in
// each method's own comment.
//
// Real implementation: ../redis/ioredis-reporter-store.ts.
import type { StatsWriteCommand } from './stats.ts';

export interface WindowStats {
	comboEntries: { key: string; stats: Record<string, string> }[];
	srcEntries: { key: string; stats: Record<string, string> }[];
}

export interface ReporterStore {
	// -- Stats (a3ff30abf87630d1) --

	/** hincrby total/combo counters, hset combo lastTimestamp, expire both at 3600s, and (if cmd.source is set) hincrby+expire the src hash -- one multi/pipeline, matching the original's single `multi.exec()`. */
	writeStatsWindow(cmd: StatsWriteCommand): Promise<void>;

	// -- Metrics (24ddb5fcccf4e13b) --

	/** HGETALL {windowKey}:total (fetched for fidelity; its result has no effect on any output -- see metrics.ts's header), KEYS {windowKey}:combo:* + their HGETALLs, KEYS {windowKey}:src:* + their HGETALLs. */
	readWindowStats(windowKey: string): Promise<WindowStats>;

	// -- Caddy webhook (8af6da8799fee66d -> 64c28b318eb1211c) --

	/** HGETALL infoGranuleKey(uri) -- the flat record finishing.ts's recordInfoGranule() wrote. Empty array if the key doesn't exist. */
	readGranule(uri: string): Promise<string[]>;

	/** EVAL LUA_ACTIVE_IPS 1 reporterActiveIpsKey() ip String(keepIpSeconds) -- returns the sliding-window distinct-IP ZCARD (see active-ips.ts). */
	recordActiveIp(ip: string, keepIpSeconds: number): Promise<number>;

	quit(): Promise<void>;
}
