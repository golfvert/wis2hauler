import { describe, expect, test } from 'bun:test';
import { DebugController } from '../debug.ts';

describe('DebugController — static/dynamic union', () => {
	test('has() is false for everything with no static and nothing set dynamically', () => {
		const d = new DebugController();
		expect(d.has('SUBSCRIBER')).toBe(false);
	});

	test('static roles are always on', () => {
		const d = new DebugController({ staticCategories: ['SUBSCRIBER', 'DOWNLOADER'] });
		expect(d.has('SUBSCRIBER')).toBe(true);
		expect(d.has('DOWNLOADER')).toBe(true);
		expect(d.has('CLEANER')).toBe(false);
	});

	test('"ALL" in static enables every role', () => {
		const d = new DebugController({ staticCategories: ['ALL'] });
		expect(d.has('SUBSCRIBER')).toBe(true);
		expect(d.has('DOWNLOADER')).toBe(true);
		expect(d.has('CLEANER')).toBe(true);
		expect(d.has('REPORTER')).toBe(true);
		expect(d.has('REPLAYER')).toBe(true);
	});

	test('setDynamic adds dynamic roles on top of static (union)', () => {
		const d = new DebugController({ staticCategories: ['SUBSCRIBER'] });
		d.setDynamic(['DOWNLOADER', 'CLEANER']);
		expect(d.has('SUBSCRIBER')).toBe(true); // still on via static
		expect(d.has('DOWNLOADER')).toBe(true);
		expect(d.has('CLEANER')).toBe(true);
	});

	test('a role turned on dynamically goes back off when a later setDynamic call omits it', () => {
		const d = new DebugController();
		d.setDynamic(['DOWNLOADER']);
		expect(d.has('DOWNLOADER')).toBe(true);
		d.setDynamic([]);
		expect(d.has('DOWNLOADER')).toBe(false);
	});

	test('a static role cannot be turned off by setDynamic, even with an empty/unrelated set', () => {
		const d = new DebugController({ staticCategories: ['SUBSCRIBER'] });
		d.setDynamic(['DOWNLOADER']);
		d.setDynamic([]); // dynamic set cleared entirely
		expect(d.has('SUBSCRIBER')).toBe(true);
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

	test('getDynamic reports only the dynamic layer, not the static baseline', () => {
		const d = new DebugController({ staticCategories: ['SUBSCRIBER'] });
		expect(d.getDynamic()).toEqual([]);
		d.setDynamic(['DOWNLOADER', 'CLEANER']);
		expect(d.getDynamic().sort()).toEqual(['CLEANER', 'DOWNLOADER']);
	});
});

describe('DebugController — onChange diff-and-reapply', () => {
	test('fires once at construction with the static baseline', () => {
		const calls: boolean[] = [];
		new DebugController({ staticCategories: ['DOWNLOADER'], onChange: { DOWNLOADER: (enabled) => calls.push(enabled) } });
		expect(calls).toEqual([true]);
	});

	test('fires again only when the EFFECTIVE state actually changes, not on every setDynamic call', () => {
		const calls: boolean[] = [];
		const d = new DebugController({ onChange: { DOWNLOADER: (enabled) => calls.push(enabled) } });
		expect(calls).toEqual([false]); // initial apply: static baseline is empty -> false

		d.setDynamic(['DOWNLOADER']);
		expect(calls).toEqual([false, true]);

		d.setDynamic(['DOWNLOADER']); // unchanged
		expect(calls).toEqual([false, true]);

		d.setDynamic(['DOWNLOADER', 'SUBSCRIBER']); // still enabled, still unchanged for "DOWNLOADER"
		expect(calls).toEqual([false, true]);

		d.setDynamic([]); // now disabled
		expect(calls).toEqual([false, true, false]);
	});

	test('a role already on via static makes a redundant setDynamic call a no-op for onChange', () => {
		const calls: boolean[] = [];
		const d = new DebugController({ staticCategories: ['DOWNLOADER'], onChange: { DOWNLOADER: (enabled) => calls.push(enabled) } });
		expect(calls).toEqual([true]);
		d.setDynamic(['DOWNLOADER']); // redundant with static — effective state unchanged
		expect(calls).toEqual([true]);
	});
});
