// Loads and validates the static YAML config file. Equivalent of the
// Node-RED Setup tab's "file in" -> "yaml" -> "Validate" chain, minus
// the Node-RED-specific plumbing (msg.filename etc.) — flows.json
// leaves the actual filename dynamic/msg-driven, so there's no fixed
// path to carry over; callers pass one explicitly (typically from a
// CLI arg or env var, decided when the process entrypoint is written).

import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { validateConfig, type ValidationResult } from './validate.ts';
import { enforceCoreCacheRule } from './topics.ts';
import type { Config } from './schema.ts';

export class ConfigError extends Error {
	constructor(
		message: string,
		public readonly result: ValidationResult,
	) {
		super(message);
		this.name = 'ConfigError';
	}
}

// WIS2 core/cache rule (../config/topics.ts's enforceCoreCacheRule),
// applied once here to the static config's subscriber.mqtt.whitelist/
// blacklist -- unless global.global-cache is true, neither may
// subscribe to core data (level 6 == 'core') straight from origin.
// Mutates `config` in place (so every later reader -- RuntimeConfigStore's
// seed, the config object handed to registerAdminRoutes -- sees the
// corrected topics) and appends one message per rewrite to `result.warnings`,
// which every existing caller (main.ts's `for (const w of result.warnings)
// log.warn(...)`) already prints -- no separate logging plumbing needed.
// The exact same rule is applied again, independently, to a live POST
// /set patch (../config/runtime.ts's validatePatch) -- a fresh
// whitelist/blacklist entry can arrive that way just as easily as
// through this file.
function applyCoreCacheRule(config: Config, warnings: string[]): void {
	if (!config.subscriber?.mqtt) return;
	const globalCacheMode = config.global['global-cache'] ?? false;
	const m = config.subscriber.mqtt;
	const log = (message: string) => warnings.push(`subscriber.mqtt: ${message}`);
	m.whitelist = enforceCoreCacheRule(m.whitelist, globalCacheMode, log);
	if (m.blacklist) m.blacklist = enforceCoreCacheRule(m.blacklist, globalCacheMode, log);
}

// Parses and validates only — does not read a file. Useful for tests
// and for validating config received some other way (e.g. handed in
// as a string).
export function parseConfig(yamlText: string): { config: Config; result: ValidationResult } {
	let raw: unknown;
	try {
		raw = parseYaml(yamlText);
	} catch (err) {
		const result: ValidationResult = {
			valid: false,
			errors: [`YAML parse error: ${err instanceof Error ? err.message : String(err)}`],
			warnings: [],
			infos: [],
		};
		throw new ConfigError('config YAML failed to parse', result);
	}

	const result = validateConfig(raw);
	if (!result.valid) {
		throw new ConfigError(`config validation failed: ${result.errors.join('; ')}`, result);
	}
	const config = raw as Config;
	applyCoreCacheRule(config, result.warnings);
	return { config, result };
}

export function loadConfig(path: string): { config: Config; result: ValidationResult } {
	const text = readFileSync(path, 'utf8');
	return parseConfig(text);
}
