import { describe, expect, test } from 'bun:test';
import { ensureNotifications } from '../expiry.ts';

function fakeConn(current: string, failSet = false) {
	const calls: unknown[][] = [];
	return {
		calls,
		config: async (...args: unknown[]) => {
			calls.push(args);
			if (args[0] === 'GET') return ['notify-keyspace-events', current];
			if (failSet) throw new Error('CONFIG disabled');
			return 'OK';
		},
	};
}

describe('ensureNotifications', () => {
	test('adds E and x, keeping existing flags', async () => {
		const c = fakeConn('K$');
		await ensureNotifications(c as never, 'n1', () => {});
		expect(c.calls[1]).toEqual(['SET', 'notify-keyspace-events', 'K$Ex']);
	});
	test('does nothing when already enabled', async () => {
		const c = fakeConn('Ex');
		await ensureNotifications(c as never, 'n1', () => {});
		expect(c.calls).toHaveLength(1);
	});
	test('A already covers x', async () => {
		const c = fakeConn('AE');
		await ensureNotifications(c as never, 'n1', () => {});
		expect(c.calls).toHaveLength(1);
	});
	test('warns when the server refuses', async () => {
		const c = fakeConn('', true);
		const warnings: string[] = [];
		await ensureNotifications(c as never, 'n1', (m) => warnings.push(m));
		expect(warnings[0]).toContain('n1');
	});
});
