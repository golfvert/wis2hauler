// Loads and validates the static YAML config file. Equivalent of the
// Node-RED Setup tab's "file in" -> "yaml" -> "Validate" chain, minus
// the Node-RED-specific plumbing (msg.filename etc.) — flows.json
// leaves the actual filename dynamic/msg-driven, so there's no fixed
// path to carry over; callers pass one explicitly (typically from a
// CLI arg or env var, decided when the process entrypoint is written).

import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';
import { validateConfig, type ValidationResult } from './validate.ts';
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
	return { config: raw as Config, result };
}

export function loadConfig(path: string): { config: Config; result: ValidationResult } {
	const text = readFileSync(path, 'utf8');
	return parseConfig(text);
}
