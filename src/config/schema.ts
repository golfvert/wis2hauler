// TypeBox structural schema for the static YAML config file (the
// deployment-time config: global/subscriber/downloader/cleaner/
// replayer/reporter). Ported from the Node-RED "Validate" function
// node (Setup tab) in flows.json.
//
// This schema captures SHAPE — types, unconditionally-required fields
// within a present section, enums, and the handful of patterns that
// are genuinely regular (URLs, broker protocol prefixes). It
// deliberately does NOT try to express in JSON Schema the things the
// original implementation treats as business rules rather than shape:
//   - role-conditional section requiredness (e.g. "subscriber" section
//     is only required if global.roles includes SUBSCRIBER) — JSON
//     Schema if/then/else could technically do this but the error
//     messages that fall out are unreadable; see validate.ts instead.
//   - "s3access required iff downloader.rename-to === 's3'" — same
//     reasoning, same home (validate.ts).
//   - the WIS2 topic grammar (see topics.ts) — a positional,
//     variable-depth grammar that's a worse regex than it is a small
//     recursive function.
//   - unknown-key detection as a WARNING (not a hard failure) — the
//     original lets a config with an unrecognized key still load,
//     just noisily. Ajv's additionalProperties:false would make that
//     a hard error instead, which is a real behavior change, not a
//     cleanup — see validate.ts's checkUnknownKeys.
//   - the original's asymmetric severity: e.g. a broker missing
//     username/password is a WARNING, not an ERROR. Ajv has one
//     severity (fail/pass), so anything the original only *warns*
//     about is deliberately left optional/untyped here and checked by
//     hand in validate.ts instead of encoded as an Ajv failure.
//
// validate.ts runs Ajv against this schema for the hard-requirement
// half, then layers the business-rule checks above on top — same
// split of responsibility the original had between JSON-shape and
// hand-written logic, just with the JSON-shape half now a real schema
// instead of ad hoc isString/isNumber calls.

import { Type, type Static } from '@sinclair/typebox';

// Redis (Valkey) connection info — added when the live pipeline was
// built (not part of the original flows.json config schema, which
// read connection details from environment/deployment config rather
// than the flow's own JSON). Supports either a single standalone node
// or a Redis Cluster, per the maintainer's request: "I'd like the option of
// using redis as a cluster or as a single node." mode picks which;
// nodes is always an array of "host:port" strings so the two modes
// share one shape — for 'single' it must contain exactly one entry
// (checked in validate.ts, since that's a cross-field rule, not a
// shape rule), for 'cluster' one or more startup/seed nodes.
export const RedisConfig = Type.Object(
	{
		mode: Type.Union([Type.Literal('single'), Type.Literal('cluster')]),
		nodes: Type.Array(Type.String({ pattern: '^[^:\\s]+:\\d+$' }), { minItems: 1 }),
		password: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
export type RedisConfig = Static<typeof RedisConfig>;

export const BrokerConfig = Type.Object(
	{
		broker: Type.String({ pattern: '^(mqtt|mqtts|ws|wss)://.+' }),
		// Missing username/password is a WARNING in the original, not a
		// structural error — kept optional here; validate.ts checks for
		// their absence and warns, matching checkBroker's behavior.
		username: Type.Optional(Type.String()),
		password: Type.Optional(Type.String()),
		version: Type.Optional(Type.Union([Type.Literal(3), Type.Literal(4), Type.Literal(5)])),
		verifycert: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);
export type BrokerConfig = Static<typeof BrokerConfig>;

// The static logging config -- NOT part of flows.json as one grouped
// object (the original had `global['log-level']`/`global['log-to']` as
// two flat, separately-typed globals, and hardcoded /logs + per-level
// rotation sizes rather than exposing them as config at all -- see
// each field's own comment below). Grouped hierarchically per the maintainer's
// explicit request ("Let's do something hierarchical with level, to,
// size and number ... under a log: entry"), replacing the earlier flat
// `global['log-level']`/`global['log-to']`/`global['log-dir']` keys.
export const LogConfig = Type.Object(
	{
		// Required -- matches the original's `global['log-level']`, which
		// was itself unconditionally required.
		level: Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('debug')]),
		to: Type.Optional(Type.Union([Type.Literal('stdout'), Type.Literal('file')])),
		// NOT part of flows.json -- the original hardcodes rotation size
		// PER LEVEL on its three file-logger config nodes (info/warn:
		// 200MB, debug: 100MB -- see src/logging/sink.ts's header). This
		// is a deliberate simplification: one configured size applied to
		// every level, not three independently-tuned ones. A plain number
		// of MEGABYTES (the maintainer: "For size just 200 (and make it default to
		// be MB). 'm' for a size is pointless.") -- no unit suffix, no
		// unit choice. Optional; sink.ts falls back to 200 when unset.
		size: Type.Optional(Type.Number({ minimum: 1 })),
		// Same simplification as `size` -- the original's three
		// file-logger nodes hardcode 25 (info), 26 (warn), 26 (debug)
		// max files; here it's one configured count for all three.
		// Optional; sink.ts falls back to 25 when unset.
		number: Type.Optional(Type.Number({ minimum: 1 })),
		// NOT part of flows.json -- the original's File-output logIO
		// loggers hardcode "/logs" (a mounted volume in the Docker
		// deployment this was built for). Optional; src/logging/sink.ts
		// defaults to "./logs" when unset.
		dir: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: true },
);
export type LogConfig = Static<typeof LogConfig>;

export const GlobalSection = Type.Object(
	{
		roles: Type.String({ minLength: 1 }), // comma-separated VALID_ROLES; parsed/checked in validate.ts
		worker: Type.String({ minLength: 1 }),
		// Every role talks to Redis (it's the shared bus/state store), so
		// this is unconditionally required, same as worker.
		redis: RedisConfig,
		// Required only when roles includes SUBSCRIBER/DOWNLOADER/CLEANER
		// — that's a cross-check, so it's optional in the shape schema.
		queue: Type.Optional(Type.String({ minLength: 1 })),
		log: LogConfig,
		'test-mode-duration': Type.Optional(Type.Number()),
		'global-cache': Type.Optional(Type.Boolean()),
		'centre-id': Type.Optional(Type.String()),
		// Missing/empty is a WARNING (PUB1/PUB2 won't connect), not an
		// error — kept optional; validate.ts warns when absent/empty and
		// again when there are more than 2 (only PUB1/PUB2 are wired).
		'local-broker': Type.Optional(Type.Array(BrokerConfig)),
		// NOT part of flows.json (Node-RED's http-in nodes bind to Node-RED's
		// own admin server -- settings.js's uiPort -- which isn't in the flow
		// JSON at all). Per the maintainer's explicit decision (asked via
		// AskUserQuestion this session, "nodered offers one port (same as the
		// UI port) for all HTTP access. So, [one shared Bun.serve] will
		// behave the same."): ONE Bun.serve() per replica, on this one port,
		// serves whichever of /reporter/primary, /caddy, /replayer/primary
		// apply to that replica's active roles. Optional; main.ts (the only
		// caller of http/router.ts's createHttpServer()) defaults to 8080
		// when unset -- same as settings.js's uiPort, this is the ONLY
		// exposure-related config this app has. How that port reaches the
		// outside world (direct expose, a hand-maintained reverse-proxy
		// config, container networking) is entirely the operator's
		// decision, made outside this app -- same as aria2's own RPC
		// port. This app never self-registers with anything.
		//
		// DELIBERATE REMOVAL, 2026-09-12 (the maintainer, deciding the shape of the
		// upcoming binary+Docker packaging work): a `TraefikConfig`/
		// `traefik:` section used to live here, self-registering this
		// worker's OS-assigned port with a Traefik file-provider on
		// startup (ported from the maintainer's own Go reference project,
		// antiloop). Removed entirely rather than made optional -- the maintainer's
		// call, after weighing it against a per-deployment toggle: the
		// only real justification for auto-registration was many workers
		// on one host needing collision-free ports with zero manual
		// coordination, and the maintainer confirmed that's not this project's
		// actual shape (1-2 downloaders per host without Docker; if that
		// ever changes, a yaml-generating tool solves it, not runtime
		// registration). Removing it also makes `http-port` consistent
		// with how every other port in this system already works
		// (aria2's RPC port has always been a manually-assigned config
		// value with no self-registration) rather than being the one
		// exception. See the project notes for the full back-and-forth.
		'http-port': Type.Optional(Type.Number({ minimum: 1, maximum: 65535 })),
	},
	{ additionalProperties: true },
);
export type GlobalSection = Static<typeof GlobalSection>;

export const OverrideRule = Type.Object(
	{
		topic: Type.Optional(Type.String()),
		'max-length': Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	},
	{ additionalProperties: false },
);
export type OverrideRule = Static<typeof OverrideRule>;

export const SubscriberMqtt = Type.Object(
	{
		whitelist: Type.Array(Type.String(), { minItems: 1 }),
		blacklist: Type.Optional(Type.Array(Type.String())),
		overridelist: Type.Optional(Type.Array(OverrideRule)),
		'global-replay': Type.Optional(Type.Union([Type.String(), Type.Null()])),
		// Setup tab's "Configuration" change node (5ebe61e8fc4d96df):
		// `$type(payload.subscriber.mqtt.qos) = "number" ? payload.subscriber.mqtt.qos : 0`
		// -- the QoS every whitelist (and replay-wrapper) topic subscribes
		// at, ported for ../election/run.ts's deriveHeartbeatTopics().
		// Not previously in this schema since nothing consumed it before now.
		qos: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);
export type SubscriberMqtt = Static<typeof SubscriberMqtt>;

export const SubscriberSection = Type.Object(
	{
		'global-broker': Type.Array(BrokerConfig, { minItems: 1 }),
		// Replaces the old 'priority-global-cache' ordered list (2026-09-20):
		// keyed by the FULL raw wnm.properties['global-cache'] string (e.g.
		// "de-dwd-global-cache"), plus the literal key "origin" for the
		// origin case -- see order-links.ts's resolveWeight() for the two
		// default rules governing an unset map vs. a key missing from a
		// present map.
		'weight-sources': Type.Optional(Type.Record(Type.String(), Type.Number({ minimum: 0 }))),
		// Delay-scale parameter (seconds) for the exponential race --
		// see order-links.ts's computeDelaySeconds().
		'weight-delay-seconds': Type.Optional(Type.Number({ minimum: 0 })),
		mqtt: SubscriberMqtt,
	},
	{ additionalProperties: true },
);
export type SubscriberSection = Static<typeof SubscriberSection>;

export const S3Access = Type.Object(
	{
		url: Type.String({ pattern: '^https?://[^/]+(:\\d+)?(/.*)?$' }),
		accesskey: Type.String({ minLength: 1 }),
		secretkey: Type.String({ minLength: 1 }),
		bucket: Type.String({ minLength: 1 }),
		// Missing region is a WARNING ("minio may use a default"), not an
		// error — kept optional.
		region: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
export type S3Access = Static<typeof S3Access>;

export const CredentialEntry = Type.Object(
	{
		username: Type.String({ minLength: 1 }),
		password: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export type CredentialEntry = Static<typeof CredentialEntry>;

export const DownloaderSection = Type.Object(
	{
		'aria-secret': Type.String({ minLength: 1 }),
		'aria-url': Type.String({ pattern: '^wss?://.+' }),
		'aria-inqueue': Type.Number({ exclusiveMinimum: 0 }),
		// The directory aria2 actually writes downloaded files into --
		// must match aria2.conf's own `dir=` exactly (same host, same
		// case: this is compared/joined as a literal string, never
		// normalized). Also where decode-write.ts's embedded-content fast
		// path writes directly, bypassing aria2 entirely -- both paths
		// share this one value so they can never disagree. Required, not
		// optional/defaulted: decode-write.ts, consumer.ts's real-aria2
		// completion gate, and cleaner-ipc.ts's delete-path reconstruction
		// each independently hardcode or assume "/downloads" -- the maintainer's
		// real aria2.conf uses a different path with different case
		// (/Users/remy/Docker/WIS2/Aria2/Downloads), which silently broke
		// every one of those assumptions at once.
		// Per the maintainer: "Never assume the dir is known." This now ALSO
		// feeds ../downloader/hash.ts's HashResult.localPath (added
		// 2026-09-13, same reasoning extended to ../cleaner/schedule.ts's
		// eviction match, which used to hardcode the literal "downloads/"
		// fleet-wide the way the original flows.json Schedule node does --
		// fine under Docker-only deployment, where every worker's directory
		// was guaranteed to contain that literal, but silently broken for a
		// bare-metal deployment with an arbitrarily-named directory; see
		// hash.ts's and schedule.ts's header comments for the full story).
		'aria-download': Type.String({ minLength: 1 }),
		// Threaded straight into aria2.addUri's "check-certificate" param
		// (Setup tab's "Aria" change node) -- optional because the
		// original just forwards whatever global.get() returns, undefined
		// included, and JSONata drops an undefined property from the
		// built object rather than sending it as null; the Bun port
		// matches that by omitting the param entirely when unset.
		'aria-check-tls': Type.Optional(Type.Boolean()),
		// Optional since 2026-09-14 (the maintainer): only needed to build the
		// local href finishing.ts's step 1/4 swaps into the cache-topic WNM
		// republish -- which itself only happens when global.local-broker has
		// at least one broker configured (see finishing.ts's own gate). A
		// deployment with no local-broker at all has nothing to republish to,
		// so it has no use for download-url either; see validate.ts's
		// cross-check for the case that's still an error (a broker IS
		// configured but download-url isn't).
		'download-url': Type.Optional(Type.String({ pattern: '^https?://.+' })),
		// 's3access' is required iff this is 's3' — a cross-check, so
		// s3access stays optional in the shape schema; see validate.ts.
		'rename-to': Type.Optional(
			Type.Union([Type.Literal('date'), Type.Literal('topic'), Type.Literal('s3'), Type.Literal(false)]),
		),
		s3access: Type.Optional(S3Access),
		// Keyed by WIS2 "recommended" topic (origin/a/wis2/<id>/recommended/...)
		// — key format is a business rule (topics.ts), not a JSON Schema
		// pattern; see validate.ts.
		credentials: Type.Optional(Type.Record(Type.String(), CredentialEntry)),
	},
	{ additionalProperties: true },
);
export type DownloaderSection = Static<typeof DownloaderSection>;

export const CleanerSection = Type.Object(
	{
		'keep-in-cache': Type.Number(), // seconds; <= 0 is a WARNING ("deleted immediately"), not an error
		// NOT part of the literal Node-RED "Validate" function (cleanup_function_simple's
		// `THRESHOLD = 12 * 3600` is hardcoded in the original) -- an original engineering
		// addition per the maintainer's standing "pull thresholds like this from the same config
		// system as everything else" decision, same category as the Reporter's prom-client
		// choice: not a guess about flows.json semantics, a deliberate improvement on top of
		// faithfully-ported behavior. Optional; src/cleaner/gc.ts defaults to 12h (43200s)
		// when unset, matching the original's hardcoded value exactly.
		'redis-gc-threshold-seconds': Type.Optional(Type.Number({ minimum: 0 })),
	},
	{ additionalProperties: true },
);
export type CleanerSection = Static<typeof CleanerSection>;

export const ReplayerSection = Type.Object(
	{
		'global-replay-url': Type.String({ pattern: '^https?://.+' }),
	},
	{ additionalProperties: true },
);
export type ReplayerSection = Static<typeof ReplayerSection>;

export const ReporterSection = Type.Object(
	{
		'keep-ip-address': Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
	},
	{ additionalProperties: true },
);
export type ReporterSection = Static<typeof ReporterSection>;

// Top level: only "global" is unconditionally required. Every other
// section's requiredness depends on global.roles — see validate.ts.
export const Config = Type.Object(
	{
		global: GlobalSection,
		subscriber: Type.Optional(SubscriberSection),
		downloader: Type.Optional(DownloaderSection),
		cleaner: Type.Optional(CleanerSection),
		replayer: Type.Optional(ReplayerSection),
		reporter: Type.Optional(ReporterSection),
	},
	{ additionalProperties: true }, // unknown top-level sections are a WARNING, not an error — see validate.ts
);
export type Config = Static<typeof Config>;

export const VALID_ROLES = ['SUBSCRIBER', 'DOWNLOADER', 'CLEANER', 'REPORTER', 'REPLAYER'] as const;
export type Role = (typeof VALID_ROLES)[number];

// Known-key allowlists, used by validate.ts to emit "present in config
// but not used by the flow" warnings — ported verbatim from the
// original's KNOWN_* arrays.
export const KNOWN_GLOBAL = [
	'roles', 'worker', 'queue', 'log', 'global-cache', 'test-mode-duration', 'local-broker', 'centre-id', 'redis', 'http-port',
] as const;
export const KNOWN_REDIS = ['mode', 'nodes', 'password'] as const;
export const KNOWN_LOG = ['level', 'to', 'size', 'number', 'dir'] as const;
export const KNOWN_SUBSCRIBER = ['global-broker', 'weight-sources', 'weight-delay-seconds', 'mqtt'] as const;
export const KNOWN_SUBSCRIBER_MQTT = ['whitelist', 'blacklist', 'overridelist', 'global-replay', 'qos'] as const;
export const KNOWN_DOWNLOADER = [
	'aria-secret', 'aria-url', 'aria-inqueue', 'aria-download', 'aria-check-tls', 'download-url', 'rename-to', 's3access', 'credentials',
] as const;
export const KNOWN_S3ACCESS = ['url', 'accesskey', 'secretkey', 'bucket', 'region'] as const;
export const KNOWN_CLEANER = ['keep-in-cache', 'redis-gc-threshold-seconds'] as const;
export const KNOWN_REPLAYER = ['global-replay-url'] as const;
export const KNOWN_REPORTER = ['keep-ip-address'] as const;
export const KNOWN_SECTIONS = ['global', 'subscriber', 'downloader', 'cleaner', 'replayer', 'reporter'] as const;
