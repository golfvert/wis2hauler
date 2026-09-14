// Validates the static YAML config against schema.ts's TypeBox shape
// (via Ajv) plus the business rules that shape alone can't express —
// role-conditional section requiredness, the WIS2 topic grammar,
// warning-vs-error severity, and unknown-key detection. Ported from
// the Node-RED "Validate" function node (Setup tab) in flows.json;
// see schema.ts's doc comment for why the split is where it is.
//
// Deliberately mirrors the original's message text closely (not just
// its behavior) so existing runbooks/muscle-memory around specific
// error strings ("global.roles: missing or empty", etc.) keep working
// unchanged after the port.

import Ajv, { type ErrorObject } from 'ajv';
import {
	Config,
	VALID_ROLES,
	KNOWN_GLOBAL,
	KNOWN_REDIS,
	KNOWN_LOG,
	KNOWN_SUBSCRIBER,
	KNOWN_SUBSCRIBER_MQTT,
	KNOWN_DOWNLOADER,
	KNOWN_S3ACCESS,
	KNOWN_CLEANER,
	KNOWN_REPLAYER,
	KNOWN_REPORTER,
	KNOWN_SECTIONS,
	type Role,
} from './schema.ts';
import { isValidMqttTopic, isValidCredentialTopic, isValidTopicPattern } from './topics.ts';

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
	infos: string[];
}

const ajv = new Ajv({ allErrors: true, strict: false });
const validateShape = ajv.compile(Config);

function formatAjvError(err: ErrorObject): string {
	let path = err.instancePath.replace(/^\//, '').replace(/\//g, '.');
	// Ajv's "required" errors point instancePath at the *parent* object,
	// naming the missing property in params.missingProperty instead —
	// fold it into the path so e.g. a missing global.worker reads as
	// "global.worker: ...", matching the original's per-field messages.
	if (err.keyword === 'required' && typeof err.params?.missingProperty === 'string') {
		path = path ? `${path}.${err.params.missingProperty}` : err.params.missingProperty;
	}
	return `${path || '(root)'}: ${err.message ?? 'invalid'}`;
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v: unknown): v is number => typeof v === 'number';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);
const isObject = (v: unknown): v is Record<string, unknown> =>
	v !== null && typeof v === 'object' && !Array.isArray(v);

function checkBroker(broker: unknown, path: string, warnings: string[], errors: string[]): void {
	if (!isObject(broker)) {
		errors.push(`${path}: not an object`);
		return;
	}
	// broker/protocol shape is already enforced by Ajv (schema.ts's
	// BrokerConfig.broker pattern); only the warning-only checks live here.
	if (!isString(broker.username)) warnings.push(`${path}.username: missing`);
	if (!isString(broker.password)) warnings.push(`${path}.password: missing`);
}

function checkUnknown(obj: unknown, known: readonly string[], path: string, warnings: string[]): void {
	if (!isObject(obj)) return;
	for (const k of Object.keys(obj)) {
		if (!known.includes(k)) warnings.push(`${path}.${k}: present in config but not used by the flow`);
	}
}

export function validateConfig(input: unknown): ValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const infos: string[] = [];

	if (!isObject(input)) {
		errors.push('Configuration root is not a valid YAML object');
		return { valid: false, errors, warnings, infos };
	}

	if (!validateShape(input)) {
		for (const err of validateShape.errors ?? []) errors.push(formatAjvError(err));
	}

	const cfg = input;
	const g = isObject(cfg.global) ? cfg.global : undefined;
	const roles: Role[] = isString(g?.roles) ? (g!.roles as string).split(',').map((r) => r.trim()) as Role[] : [];

	// ─── global: role-derived cross-checks Ajv can't express ──────────────

	if (g) {
		const unknown = roles.filter((r) => !(VALID_ROLES as readonly string[]).includes(r));
		if (isString(g.roles)) {
			if (unknown.length) errors.push(`global.roles: unknown role(s): ${unknown.join(', ')}`);
			else infos.push(`global.roles: ${roles.join(', ')}`);

			if (roles.includes('SUBSCRIBER') && !isObject(cfg.subscriber)) errors.push('global.roles includes SUBSCRIBER but subscriber: section is missing');
			if (roles.includes('DOWNLOADER') && !isObject(cfg.downloader)) errors.push('global.roles includes DOWNLOADER but downloader: section is missing');
			if (roles.includes('REPLAYER') && !isObject(cfg.replayer)) errors.push('global.roles includes REPLAYER but replayer: section is missing');
		}

		if (roles.some((r) => (['SUBSCRIBER', 'DOWNLOADER', 'CLEANER'] as Role[]).includes(r)) && !isString(g.queue)) {
			errors.push('global.queue: missing or empty');
		}

		if (!isArray(g['local-broker']) || (g['local-broker'] as unknown[]).length === 0) {
			warnings.push('global.local-broker: missing or empty — no local MQTT broker configured (PUB1/PUB2 will not connect)');
		} else {
			const brokers = g['local-broker'] as unknown[];
			brokers.forEach((b, i) => checkBroker(b, `global.local-broker[${i}]`, warnings, errors));
			if (brokers.length > 2) warnings.push('global.local-broker: more than 2 brokers defined — only PUB1 and PUB2 are wired in the flow');
		}

		if (isObject(g.redis)) {
			const r = g.redis;
			checkUnknown(r, KNOWN_REDIS, 'global.redis', warnings);
			if (r.mode === 'single' && isArray(r.nodes) && (r.nodes as unknown[]).length !== 1) {
				errors.push(`global.redis.nodes: mode is 'single' but ${(r.nodes as unknown[]).length} node(s) were given — single mode takes exactly one "host:port"`);
			}
			if (isArray(r.nodes)) infos.push(`global.redis: mode=${String(r.mode)}, ${(r.nodes as unknown[]).length} node(s)`);
		}

		if (isObject(g.log)) {
			const l = g.log;
			checkUnknown(l, KNOWN_LOG, 'global.log', warnings);
			if (isString(l.level)) infos.push(`global.log: level=${l.level}, to=${String(l.to ?? 'stdout')}, size=${String(l.size ?? 200)}MB, number=${String(l.number ?? 25)}`);
		}
	}

	// ─── subscriber ─────────────────────────────────────────────────────────

	if (isObject(cfg.subscriber)) {
		const s = cfg.subscriber;
		if (isArray(s['global-broker'])) {
			const brokers = s['global-broker'] as unknown[];
			brokers.forEach((b, i) => checkBroker(b, `subscriber.global-broker[${i}]`, warnings, errors));
			if (brokers.length > 2) warnings.push('subscriber.global-broker: more than 2 brokers defined — only GB1 and GB2 are wired in the flow');
		}

		if (isObject(s.mqtt)) {
			const m = s.mqtt;
			if (isArray(m.whitelist)) {
				(m.whitelist as unknown[]).forEach((t, i) => {
					const err = isValidMqttTopic(t);
					if (err) errors.push(`subscriber.mqtt.whitelist[${i}]: '${String(t)}' — ${err}`);
				});
				infos.push(`subscriber.mqtt.whitelist: ${(m.whitelist as unknown[]).length} topic(s)`);
			}
			if (m.blacklist !== undefined) {
				if (isArray(m.blacklist)) {
					(m.blacklist as unknown[]).forEach((t, i) => {
						if (!isValidTopicPattern(t)) errors.push(`subscriber.mqtt.blacklist[${i}]: '${String(t)}' — only alphanumeric, -, +, # and / allowed`);
					});
					infos.push(`subscriber.mqtt.blacklist: ${(m.blacklist as unknown[]).length} topic(s)`);
				}
			}
			if (m.overridelist !== undefined && isArray(m.overridelist)) {
				const list = m.overridelist as Record<string, unknown>[];
				list.forEach((entry, i) => {
					const base = `subscriber.mqtt.overridelist[${i}]`;
					if (entry.topic !== undefined && !isValidTopicPattern(entry.topic))
						errors.push(`${base}.topic: '${String(entry.topic)}' — only alphanumeric, -, +, # and / allowed`);
				});
				infos.push(`subscriber.mqtt.overridelist: ${list.length} rule(s)`);
			}
			if (m['global-replay'] !== undefined && m['global-replay'] !== null && isString(m['global-replay'])) {
				infos.push(`subscriber.mqtt.global-replay: ${m['global-replay'] as string}`);
			}
		}
	}

	// ─── downloader ─────────────────────────────────────────────────────────

	if (isObject(cfg.downloader)) {
		const d = cfg.downloader;

		// 2026-09-14 (the maintainer): download-url is only ever needed to
		// build the local href finishing.ts's step 1/4 swaps into the
		// cache-topic WNM before republishing it to global.local-broker --
		// see that file's publishClients gate. No local-broker configured
		// means no republish ever happens, so no download-url is needed
		// either; Ajv (schema.ts) no longer requires the key at all, this is
		// the cross-field check Ajv can't express on its own.
		const localBrokerConfigured = isArray(g?.['local-broker']) && (g!['local-broker'] as unknown[]).length > 0;
		if (d['download-url'] === undefined) {
			if (localBrokerConfigured) {
				errors.push("downloader.download-url: required when global.local-broker is configured — needed to build the cache-topic WNM republish's local link");
			} else {
				infos.push('downloader.download-url: not set — no global.local-broker configured, so no cache-topic WNM will ever be prepared/republished');
			}
		}

		const renameTo = d['rename-to'];
		let renameS3 = false;
		if (renameTo === undefined) infos.push('downloader.rename-to: not set — no renaming');
		else if (renameTo === false) infos.push('downloader.rename-to: false — no renaming');
		else if (typeof renameTo === 'string' && ['date', 'topic', 's3'].includes(renameTo)) {
			infos.push(`downloader.rename-to: ${renameTo}`);
			renameS3 = renameTo === 's3';
		}

		if (renameS3) {
			if (!isObject(d.s3access)) errors.push("downloader.s3access: required when rename-to is 's3' but section is missing");
			else if (!isString((d.s3access as Record<string, unknown>).region))
				warnings.push('downloader.s3access.region: missing — minio may use a default');
		} else if (isObject(d.s3access)) {
			warnings.push("downloader.s3access: defined but rename-to is not 's3' — section will be ignored");
		}

		if (d.credentials !== undefined && isObject(d.credentials)) {
			const creds = d.credentials;
			Object.entries(creds).forEach(([topic, entry]) => {
				const topicErr = isValidCredentialTopic(topic);
				if (topicErr) errors.push(`downloader.credentials['${topic}']: invalid topic — ${topicErr}`);
			});
			infos.push(`downloader.credentials: ${Object.keys(creds).length} topic(s) with credentials`);
		}
	}

	// ─── cleaner (role-conditional; missing section is only a WARNING) ──────

	if (roles.includes('CLEANER')) {
		if (!isObject(cfg.cleaner)) {
			warnings.push('cleaner: section missing — files will never be cleaned from cache; consider using rename-to s3 in the downloader section instead');
		} else {
			const c = cfg.cleaner;
			if (isNumber(c['keep-in-cache']) && (c['keep-in-cache'] as number) <= 0) {
				warnings.push('cleaner.keep-in-cache: value is <= 0 — files will be deleted immediately');
			}
		}

		// REMOVED, 2026-09-13 (the maintainer, quoting flows.json directly): this
		// used to warn when downloader['aria-download'] was unset, on the
		// theory that ../cleaner/schedule.ts's eviction-matching needed it.
		// It doesn't -- the original Schedule node (657fefb1a3a5afae) hardcodes
		// the literal 'downloads/' fleet-wide, with no config lookup at all,
		// and neither does any other node in the Cleaner tab. CLEANER runs
		// via one elected instance reading a global (not per-worker)
		// psubscribe across the whole fleet, so there was never "this
		// replica's own aria-download" for it to need in the first place --
		// see schedule.ts's header comment for the full correction. This
		// warning was itself a symptom of the same invented dependency and
		// is gone along with it.
	}

	// ─── reporter ─────────────────────────────────────────────────────────

	if (isObject(cfg.reporter) && isNumber(cfg.reporter['keep-ip-address'])) {
		infos.push(`reporter.keep-ip-address: ${cfg.reporter['keep-ip-address']}`);
	}

	// ─── cross-checks ─────────────────────────────────────────────────────

	if (isObject(cfg.subscriber) && isObject(cfg.subscriber.mqtt)) {
		const gr = cfg.subscriber.mqtt['global-replay'];
		if (gr && gr !== 'null' && !roles.includes('REPLAYER')) {
			warnings.push('subscriber.mqtt.global-replay is set but REPLAYER is not in global.roles');
		}
	}

	// ─── unknown / unused fields (warnings, not errors) ─────────────────────

	checkUnknown(cfg.global, KNOWN_GLOBAL, 'global', warnings);
	checkUnknown(cfg.subscriber, KNOWN_SUBSCRIBER, 'subscriber', warnings);
	if (isObject(cfg.subscriber) && isObject(cfg.subscriber.mqtt)) checkUnknown(cfg.subscriber.mqtt, KNOWN_SUBSCRIBER_MQTT, 'subscriber.mqtt', warnings);
	checkUnknown(cfg.downloader, KNOWN_DOWNLOADER, 'downloader', warnings);
	if (isObject(cfg.downloader) && isObject(cfg.downloader.s3access)) checkUnknown(cfg.downloader.s3access, KNOWN_S3ACCESS, 'downloader.s3access', warnings);
	checkUnknown(cfg.cleaner, KNOWN_CLEANER, 'cleaner', warnings);
	checkUnknown(cfg.replayer, KNOWN_REPLAYER, 'replayer', warnings);
	checkUnknown(cfg.reporter, KNOWN_REPORTER, 'reporter', warnings);
	for (const k of Object.keys(cfg)) {
		if (!(KNOWN_SECTIONS as readonly string[]).includes(k)) warnings.push(`${k}: unknown top-level section — not used by the flow`);
	}

	return { valid: errors.length === 0, errors, warnings, infos };
}
