import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { load as parseYaml, dump as dumpYaml } from 'js-yaml';
import { validateConfig } from '../validate.ts';
import { parseConfig, ConfigError } from '../load.ts';

const validYaml = readFileSync(new URL('../../../fixtures/example.valid.yaml', import.meta.url), 'utf8');
const invalidYaml = readFileSync(new URL('../../../fixtures/example.invalid.yaml', import.meta.url), 'utf8');

describe('validateConfig — valid fixture', () => {
	test('is valid with no errors', () => {
		const result = validateConfig(parseYaml(validYaml));
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	test('reports the expected infos (roles, whitelist/blacklist/overridelist counts, rename-to)', () => {
		const result = validateConfig(parseYaml(validYaml));
		expect(result.infos).toContain('global.roles: SUBSCRIBER, DOWNLOADER, CLEANER, REPORTER, REPLAYER');
		expect(result.infos).toContain('subscriber.mqtt.whitelist: 2 topic(s)');
		expect(result.infos).toContain('subscriber.mqtt.blacklist: 1 topic(s)');
		expect(result.infos).toContain('subscriber.mqtt.overridelist: 1 rule(s)');
		expect(result.infos).toContain('downloader.rename-to: s3');
		expect(result.infos).toContain('downloader.credentials: 1 topic(s) with credentials');
	});

	test('parseConfig returns a typed Config for the same fixture', () => {
		const { config, result } = parseConfig(validYaml);
		expect(result.valid).toBe(true);
		expect(config.global.worker).toBe('wis2hauler-01');
		expect(config.downloader?.['rename-to']).toBe('s3');
	});
});

describe('validateConfig — invalid fixture', () => {
	test('is invalid, and reports one error per distinct problem', () => {
		const result = validateConfig(parseYaml(invalidYaml));
		expect(result.valid).toBe(false);

		// global.worker missing (Ajv-level, required field)
		expect(result.errors.some((e) => e.startsWith('global.worker'))).toBe(true);
		// global.queue missing but required (SUBSCRIBER role present)
		expect(result.errors).toContain('global.queue: missing or empty');
		// unknown role FOOBAR
		expect(result.errors).toContain('global.roles: unknown role(s): FOOBAR');
		// log.level not a valid enum value (Ajv-level)
		expect(result.errors.some((e) => e.startsWith('global.log.level'))).toBe(true);
		// subscriber.mqtt.whitelist empty (Ajv-level, minItems)
		expect(result.errors.some((e) => e.startsWith('subscriber.mqtt.whitelist'))).toBe(true);
		// downloader.aria-url not ws(s)://
		expect(result.errors.some((e) => e.startsWith('downloader.aria-url'))).toBe(true);
		// downloader.aria-inqueue not positive
		expect(result.errors.some((e) => e.startsWith('downloader.aria-inqueue'))).toBe(true);
		// downloader.aria-secret missing entirely (Ajv-level, required)
		expect(result.errors.some((e) => e.startsWith('downloader.aria-secret'))).toBe(true);
		// downloader.download-url missing entirely (Ajv-level, required)
		expect(result.errors.some((e) => e.startsWith('downloader.download-url'))).toBe(true);
		// rename-to: s3 with no s3access section
		expect(result.errors).toContain("downloader.s3access: required when rename-to is 's3' but section is missing");
	});

	test('loadConfig-equivalent throws ConfigError carrying the full result', () => {
		expect(() => parseConfig(invalidYaml)).toThrow(ConfigError);
		try {
			parseConfig(invalidYaml);
			throw new Error('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			if (err instanceof ConfigError) {
				expect(err.result.valid).toBe(false);
				expect(err.result.errors.length).toBeGreaterThan(0);
			}
		}
	});
});

describe('validateConfig — warning-only cases (should not fail validation)', () => {
	test('missing local-broker warns but stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		delete cfg.global['local-broker'];
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('global.local-broker: missing or empty — no local MQTT broker configured (PUB1/PUB2 will not connect)');
	});

	test('broker missing username/password warns but stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global['local-broker'][0] = { broker: 'mqtts://pub1.example.org:8883' };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('global.local-broker[0].username: missing');
		expect(result.warnings).toContain('global.local-broker[0].password: missing');
	});

	test('unknown top-level section warns but stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.notasection = { foo: 'bar' };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('notasection: unknown top-level section — not used by the flow');
	});

	test('cleaner section missing when CLEANER role present is a warning, not an error', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		delete cfg.cleaner;
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings.some((w) => w.startsWith('cleaner: section missing'))).toBe(true);
	});
});

describe('validateConfig — global.redis (single vs. cluster mode)', () => {
	test('the valid fixture uses cluster mode with 3 nodes and reports an info line', () => {
		const result = validateConfig(parseYaml(validYaml));
		expect(result.valid).toBe(true);
		expect(result.infos).toContain('global.redis: mode=cluster, 3 node(s)');
	});

	test('single mode with exactly one node is valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global.redis = { mode: 'single', nodes: ['redis.example.org:6379'] };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.infos).toContain('global.redis: mode=single, 1 node(s)');
	});

	test('single mode with more than one node is an error', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global.redis = { mode: 'single', nodes: ['redis-1.example.org:6379', 'redis-2.example.org:6379'] };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith('global.redis.nodes'))).toBe(true);
	});

	test('cluster mode with several nodes stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global.redis = { mode: 'cluster', nodes: ['a:6379', 'b:6379'] };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
	});

	test('an unknown key under global.redis warns but stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global.redis.tls = true;
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('global.redis.tls: present in config but not used by the flow');
	});

	test('missing global.redis entirely is an Ajv-level required error', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		delete cfg.global.redis;
		const result = validateConfig(cfg);
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.startsWith('global.redis'))).toBe(true);
	});
});

// DELIBERATE REMOVAL, 2026-09-12: global.traefik (Traefik dynamic-
// config self-registration) no longer exists at all -- see schema.ts's
// GlobalSection doc comment. Replaced the old describe block (which
// tested that section's own optionality/defaulting) with a regression
// test confirming a leftover `traefik:` block in an old config now
// surfaces as an ordinary unknown-key warning, same as any other
// stale/unrecognized global field, rather than being silently
// accepted and acted on.
describe('validateConfig — a leftover global.traefik block (removed feature) warns as an unknown key', () => {
	test('global.traefik is no longer recognized -- present in an old config, it warns but stays valid', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global.traefik = { 'dynamic-dir': '/custom/dynamic' };
		const result = validateConfig(cfg);
		expect(result.valid).toBe(true);
		expect(result.warnings).toContain('global.traefik: present in config but not used by the flow');
	});
});

// WIS2 core/cache rule (../topics.ts's enforceCoreCacheRule), applied
// once at config-load time by ../load.ts's parseConfig -- see that
// file's applyCoreCacheRule for why it lives there (mutates the parsed
// config and folds its message into result.warnings, which every
// caller already logs) rather than in validateConfig above, which
// stays pure/non-mutating. The identical rule, applied to a live POST
// /set patch instead, is covered in ../__tests__/runtime.test.ts.
describe('parseConfig — WIS2 core/cache rule (subscriber.mqtt.whitelist/blacklist)', () => {
	test('rewrites an origin/.../core/... whitelist entry to cache/... and warns, when global-cache is not set', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		cfg.global['global-cache'] = false;
		cfg.subscriber.mqtt.whitelist.push('origin/a/wis2/fr-meteofrance/data/core/weather/surface');
		cfg.subscriber.mqtt.blacklist.push('origin/a/wis2/fr-meteofrance/data/core/#');

		const { config, result } = parseConfig(dumpYaml(cfg));
		expect(result.valid).toBe(true);
		expect(config.subscriber?.mqtt.whitelist).toContain('cache/a/wis2/fr-meteofrance/data/core/weather/surface');
		expect(config.subscriber?.mqtt.whitelist).not.toContain('origin/a/wis2/fr-meteofrance/data/core/weather/surface');
		expect(config.subscriber?.mqtt.blacklist).toContain('cache/a/wis2/fr-meteofrance/data/core/#');
		expect(result.warnings.some((w) => w.includes('subscriber.mqtt') && w.includes('core/weather/surface'))).toBe(true);
	});

	test('leaves origin/.../core/... alone when global-cache IS set (the fixture default)', () => {
		const cfg = parseYaml(validYaml) as Record<string, any>;
		expect(cfg.global['global-cache']).toBe(true); // sanity-check the fixture's own assumption
		cfg.subscriber.mqtt.whitelist.push('origin/a/wis2/fr-meteofrance/data/core/weather/surface');

		const { config, result } = parseConfig(dumpYaml(cfg));
		expect(config.subscriber?.mqtt.whitelist).toContain('origin/a/wis2/fr-meteofrance/data/core/weather/surface');
		expect(result.warnings.some((w) => w.includes('core/weather/surface'))).toBe(false);
	});
});
