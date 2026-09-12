import { describe, expect, test } from 'bun:test';
import { discoverReplayTopics, TOPIC_DISCOVERY_ALIVE_MS } from '../discovery.ts';

function flatFrom(workers: Record<string, Record<string, string>>): string[] {
	const flat: string[] = [];
	for (const [worker, fields] of Object.entries(workers)) {
		for (const [field, value] of Object.entries(fields)) flat.push(`${worker}:${field}`, value);
	}
	return flat;
}

describe('discoverReplayTopics', () => {
	test('collects string topics from an alive worker\'s topics field', () => {
		const flat = flatFrom({ 'worker-1': { ts: '1000', topics: JSON.stringify(['a/wis2/x', 'a/wis2/y']) } });
		expect(discoverReplayTopics(flat, 1500).sort()).toEqual(['a/wis2/x', 'a/wis2/y']);
	});

	test('extracts .topic from object-shaped entries ({topic, qos})', () => {
		const flat = flatFrom({ 'worker-1': { ts: '1000', topics: JSON.stringify([{ topic: 'a/wis2/x', qos: 1 }]) } });
		expect(discoverReplayTopics(flat, 1500)).toEqual(['a/wis2/x']);
	});

	test('excludes topics already prefixed "replay/a/wis2"', () => {
		const flat = flatFrom({ 'worker-1': { ts: '1000', topics: JSON.stringify(['a/wis2/x', 'replay/a/wis2/centre/uuid/a/wis2/y']) } });
		expect(discoverReplayTopics(flat, 1500)).toEqual(['a/wis2/x']);
	});

	test('dedupes topics across multiple workers', () => {
		const flat = flatFrom({
			'worker-1': { ts: '1000', topics: JSON.stringify(['a/wis2/x']) },
			'worker-2': { ts: '1000', topics: JSON.stringify(['a/wis2/x', 'a/wis2/z']) },
		});
		expect(discoverReplayTopics(flat, 1500).sort()).toEqual(['a/wis2/x', 'a/wis2/z']);
	});

	test('a worker whose heartbeat is >= 60s old (TOPIC_DISCOVERY_ALIVE_MS) is excluded, even though 8s-alive election would already exclude it too', () => {
		const flat = flatFrom({ 'worker-1': { ts: '0', topics: JSON.stringify(['a/wis2/x']) } });
		expect(discoverReplayTopics(flat, TOPIC_DISCOVERY_ALIVE_MS - 1)).toEqual(['a/wis2/x']);
		expect(discoverReplayTopics(flat, TOPIC_DISCOVERY_ALIVE_MS)).toEqual([]);
	});

	test('a worker with no topics field, or malformed/non-array JSON, contributes nothing without throwing', () => {
		const flatNone = flatFrom({ 'worker-1': { ts: '1000' } });
		expect(discoverReplayTopics(flatNone, 1500)).toEqual([]);

		const flatBad = flatFrom({ 'worker-1': { ts: '1000', topics: 'not json' } });
		expect(discoverReplayTopics(flatBad, 1500)).toEqual([]);

		const flatNotArray = flatFrom({ 'worker-1': { ts: '1000', topics: JSON.stringify({ topic: 'x' }) } });
		expect(discoverReplayTopics(flatNotArray, 1500)).toEqual([]);
	});
});
