import { describe, expect, test } from 'bun:test';
import { DebugController } from '../debug.ts';

describe('DebugController', () => {
	test('has() is false for everything with nothing set', () => {
		const d = new DebugController();
		expect(d.has('SUBSCRIBER')).toBe(false);
	});

	test('setDynamic turns roles on', () => {
		const d = new DebugController();
		d.setDynamic(['DOWNLOADER', 'CLEANER']);
		expect(d.has('DOWNLOADER')).toBe(true);
		expect(d.has('CLEANER')).toBe(true);
		expect(d.has('SUBSCRIBER')).toBe(false);
	});

	test('"ALL" enables every role', () => {
		const d = new DebugController();
		d.setDynamic(['ALL']);
		expect(d.has('SUBSCRIBER')).toBe(true);
		expect(d.has('DOWNLOADER')).toBe(true);
		expect(d.has('CLEANER')).toBe(true);
		expect(d.has('REPORTER')).toBe(true);
		expect(d.has('REPLAYER')).toBe(true);
	});

	test('a role turned on goes back off when a later setDynamic call omits it', () => {
		const d = new DebugController();
		d.setDynamic(['DOWNLOADER']);
		expect(d.has('DOWNLOADER')).toBe(true);
		d.setDynamic([]);
		expect(d.has('DOWNLOADER')).toBe(false);
	});

	test('setDynamic ignores unrecognized categories defensively, rather than corrupting state', () => {
		const d = new DebugController();
		d.setDynamic(['DOWNLOADER', 'NOTAROLE']);
		expect(d.has('DOWNLOADER')).toBe(true);
		// nothing else should have snuck in
		expect(d.has('SUBSCRIBER')).toBe(false);
		expect(d.has('CLEANER')).toBe(false);
	});

	test('categories passed to setDynamic are matched case-insensitively (normalized to uppercase)', () => {
		const d = new DebugController();
		d.setDynamic(['downloader']);
		expect(d.has('DOWNLOADER')).toBe(true);
	});

	test('getDynamic reports the current set', () => {
		const d = new DebugController();
		expect(d.getDynamic()).toEqual([]);
		d.setDynamic(['DOWNLOADER', 'CLEANER']);
		expect(d.getDynamic().sort()).toEqual(['CLEANER', 'DOWNLOADER']);
	});
});

describe('DebugController — onChange diff-and-reapply', () => {
	test('fires once at construction with the (empty) initial state', () => {
		const calls: boolean[] = [];
		new DebugController({ onChange: { DOWNLOADER: (enabled) => calls.push(enabled) } });
		expect(calls).toEqual([false]);
	});

	test('fires again only when the EFFECTIVE state actually changes, not on every setDynamic call', () => {
		const calls: boolean[] = [];
		const d = new DebugController({ onChange: { DOWNLOADER: (enabled) => calls.push(enabled) } });
		expect(calls).toEqual([false]); // initial apply: nothing set yet -> false

		d.setDynamic(['DOWNLOADER']);
		expect(calls).toEqual([false, true]);

		d.setDynamic(['DOWNLOADER']); // unchanged
		expect(calls).toEqual([false, true]);

		d.setDynamic(['DOWNLOADER', 'SUBSCRIBER']); // still enabled, still unchanged for "DOWNLOADER"
		expect(calls).toEqual([false, true]);

		d.setDynamic([]); // now disabled
		expect(calls).toEqual([false, true, false]);
	});
});
