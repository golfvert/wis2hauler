import { describe, expect, test } from 'bun:test';
import { deriveHeartbeatTopics } from '../run.ts';
import type { Config } from '../../config/schema.ts';

function baseConfig(overrides: Partial<Config['subscriber']> = {}): Config {
	return {
		global: { roles: 'SUBSCRIBER', worker: 'w1', redis: { mode: 'single', nodes: ['localhost:6379'] }, log: { level: 'info' } },
		subscriber: {
			'global-broker': [{ broker: 'mqtt://x', username: 'u', password: 'p' }],
			mqtt: { whitelist: [' origin/a/wis2/centre/data/core/weather '], ...overrides },
		},
	} as unknown as Config;
}

describe('deriveHeartbeatTopics', () => {
	test('trims and wraps each whitelist entry with qos (default 0)', () => {
		const topics = deriveHeartbeatTopics(baseConfig(), 'uuid-1');
		expect(topics).toEqual([{ topic: 'origin/a/wis2/centre/data/core/weather', qos: 0 }]);
	});

	test('uses subscriber.mqtt.qos when it is a number', () => {
		const topics = deriveHeartbeatTopics(baseConfig({ qos: 1 } as never), 'uuid-1');
		expect(topics).toEqual([{ topic: 'origin/a/wis2/centre/data/core/weather', qos: 1 }]);
	});

	test('appends the replay-wrapper topic when global-replay is a non-null string', () => {
		const topics = deriveHeartbeatTopics(baseConfig({ 'global-replay': 'centre-x' } as never), 'uuid-1');
		expect(topics).toEqual([
			{ topic: 'origin/a/wis2/centre/data/core/weather', qos: 0 },
			{ topic: 'replay/a/wis2/centre-x/uuid-1/#', qos: 0 },
		]);
	});

	test('a null global-replay does not append the wrapper topic', () => {
		const topics = deriveHeartbeatTopics(baseConfig({ 'global-replay': null } as never), 'uuid-1');
		expect(topics).toEqual([{ topic: 'origin/a/wis2/centre/data/core/weather', qos: 0 }]);
	});

	test('a replica with no subscriber section returns an empty array', () => {
		const config = { global: { roles: 'CLEANER', worker: 'w1', redis: { mode: 'single', nodes: ['localhost:6379'] }, log: { level: 'info' } } } as unknown as Config;
		expect(deriveHeartbeatTopics(config, 'uuid-1')).toEqual([]);
	});
});
