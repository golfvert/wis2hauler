import { describe, expect, test } from 'bun:test';
import { decideClaimAction } from '../claim.ts';

describe('decideClaimAction', () => {
	test('already complete short-circuits regardless of claim/nocache/mode', () => {
		expect(decideClaimAction({ alreadyComplete: true, claimed: true, nocache: false, globalCacheMode: true }))
			.toEqual({ kind: 'already-complete' });
	});
	test('claimed + global-cache mode + nocache -> publish-only', () => {
		expect(decideClaimAction({ alreadyComplete: false, claimed: true, nocache: true, globalCacheMode: true }))
			.toEqual({ kind: 'publish-only' });
	});
	test('claimed + nocache but NOT global-cache mode -> download (mode gates the publish-only path)', () => {
		expect(decideClaimAction({ alreadyComplete: false, claimed: true, nocache: true, globalCacheMode: false }))
			.toEqual({ kind: 'download' });
	});
	test('claimed + not nocache -> download', () => {
		expect(decideClaimAction({ alreadyComplete: false, claimed: true, nocache: false, globalCacheMode: true }))
			.toEqual({ kind: 'download' });
	});
	test('not claimed + not nocache -> wait', () => {
		expect(decideClaimAction({ alreadyComplete: false, claimed: false, nocache: false, globalCacheMode: true }))
			.toEqual({ kind: 'wait' });
	});
	test('not claimed + nocache -> drop', () => {
		expect(decideClaimAction({ alreadyComplete: false, claimed: false, nocache: true, globalCacheMode: true }))
			.toEqual({ kind: 'drop' });
	});
});
