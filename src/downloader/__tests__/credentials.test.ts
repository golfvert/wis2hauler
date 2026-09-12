import { describe, expect, test } from 'bun:test';
import { parseCredentials, pollCredentials, seedCredentials } from '../credentials.ts';
import { FakeDownloaderStore } from './fakes.ts';

describe('parseCredentials', () => {
	test('parses each field value as JSON into a topic -> {username,password} map', () => {
		const warnings: string[] = [];
		const flat = ['topic/a', JSON.stringify({ username: 'alice', password: 'p1' }), 'topic/b', JSON.stringify({ username: 'bob', password: 'p2' })];

		const result = parseCredentials(flat, (m) => warnings.push(m));

		expect(result).toEqual({ 'topic/a': { username: 'alice', password: 'p1' }, 'topic/b': { username: 'bob', password: 'p2' } });
		expect(warnings).toHaveLength(0);
	});

	test('a field whose value fails to parse as JSON is warned about and skipped, other fields still parse', () => {
		const warnings: string[] = [];
		const flat = ['topic/a', 'not json', 'topic/b', JSON.stringify({ username: 'bob', password: 'p2' })];

		const result = parseCredentials(flat, (m) => warnings.push(m));

		expect(result).toEqual({ 'topic/b': { username: 'bob', password: 'p2' } });
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('topic/a');
	});

	test('empty flat array -> empty map', () => {
		expect(parseCredentials([], () => {})).toEqual({});
	});
});

describe('pollCredentials', () => {
	test('reads the credentials hash off the store and parses it', async () => {
		const store = new FakeDownloaderStore();
		store.credentials['topic/a'] = JSON.stringify({ username: 'alice', password: 'p1' });

		const result = await pollCredentials(store, () => {});

		expect(result).toEqual({ 'topic/a': { username: 'alice', password: 'p1' } });
	});
});

describe('seedCredentials', () => {
	test('is a no-op when there are no configured credentials at all', async () => {
		const store = new FakeDownloaderStore();
		await seedCredentials(store, undefined);
		expect(store.credentials).toEqual({});
	});

	test('is a no-op for an empty credentials object', async () => {
		const store = new FakeDownloaderStore();
		await seedCredentials(store, {});
		expect(store.credentials).toEqual({});
	});

	test('seeds every configured credential onto the store', async () => {
		const store = new FakeDownloaderStore();
		await seedCredentials(store, { 'topic/a': { username: 'alice', password: 'p1' } });
		expect(store.credentials['topic/a']).toBe(JSON.stringify({ username: 'alice', password: 'p1' }));
	});
});
