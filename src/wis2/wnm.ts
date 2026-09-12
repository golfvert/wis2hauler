// Canonical WIS2 Notification Message (WNM) type and the small set of
// link-selection helpers used throughout Subscriber (and, later,
// Downloader). Ported from flows.json, where the same "prefer the
// 'update' link, fall back to 'canonical'" JSONata expression was
// written out three times (both Setup/Subscriber "Init" function
// nodes, plus Override's length lookup) and messages were read
// inconsistently as msg.wnm or msg.payload depending on which
// function wrote them — see the project's architecture notes (C.1,
// "canonicalize the WNM envelope"). This module is that
// canonicalization: one Wnm type, one selectLink() used everywhere a
// link needs picking.
//
// Fields beyond what these roles actually read are deliberately left
// as an open index signature rather than fully modeled — the full WMO
// WNM schema is validated elsewhere (Ajv against the bundled WIS2
// JSON Schemas, per the maintainer's existing infra work); this type exists to
// give the *fields this codebase touches* real types, not to
// re-implement that schema.

export interface WnmLink {
	rel: string; // 'canonical' | 'update' | 'deletion' | others per the WMO spec
	href: string | string[];
	type?: string | string[];
	length?: number;
	integrity?: { value?: string; method?: string };
	[key: string]: unknown;
}

export interface WnmProperties {
	pubtime: string;
	data_id: string;
	cache?: boolean;
	integrity?: { value?: string; method?: string };
	'global-cache'?: string;
	content?: unknown;
	[key: string]: unknown;
}

export interface Wnm {
	id: string;
	links: WnmLink[];
	properties: WnmProperties;
	// Present transiently while a message is in flight through the
	// Subscriber/Downloader pipeline; absent on the wire.
	downloader_id?: string;
	[key: string]: unknown;
}

// Picks the link this pipeline should act on: 'update' if present,
// otherwise 'canonical'. Ported from the repeated
// `$exists(wnm.links[rel="update"].X) ? ... : wnm.links[rel="canonical"].X`
// JSONata pattern.
export function selectLink(wnm: Wnm): WnmLink | undefined {
	return wnm.links?.find((l) => l.rel === 'update') ?? wnm.links?.find((l) => l.rel === 'canonical');
}

// A link's href/type can be a single string or an array of
// alternatives (mirrors/format variants) per the WNM spec. This
// codebase only ever acts on the *first* alternative (see the
// original's "HREFs ?" switch + split + "Index ? === 0" chain, which
// discards everything past index 0) — firstOf is that same "take the
// first, string-or-array either way" step, named for reuse at every
// call site instead of repeating the array check.
export function firstOf(value: string | string[] | undefined): string | undefined {
	if (value === undefined) return undefined;
	return Array.isArray(value) ? value[0] : value;
}

// Declared size in bytes for the link selectLink() would pick, or
// fallback if absent — same fallback value (99999) the original used
// when neither update nor canonical declares a length.
export function linkLength(wnm: Wnm, fallback = 99999): number {
	return selectLink(wnm)?.length ?? fallback;
}
