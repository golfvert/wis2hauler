import { describe, expect, test } from 'bun:test';
import { decideRetry } from '../retry';

describe('decideRetry', () => {
	test('empty record -> RETRY_NOK, no-op', () => {
		const result = decideRetry([]);
		expect(result).toEqual({
			retry: 'RETRY_NOK',
			payload: [],
			extracted: null,
			delaySeconds: undefined,
			promoteHref: '',
			promoteSource: '',
			newAttempt: '',
			errorHref: '',
			errorSource: '',
		});
	});

	test('does not mutate the caller-supplied array', () => {
		const input = ['http://a', 'queue', 'attempt', '2'];
		const before = [...input];
		decideRetry(input);
		expect(input).toEqual(before);
	});

	test('a lone "queue" href with nothing else -> marked error, RETRY_NOK', () => {
		const result = decideRetry(['http://a', 'queue', 'attempt', '2']);
		expect(result.retry).toBe('RETRY_NOK');
		expect(result.errorHref).toBe('http://a');
		expect(result.errorSource).toBe('');
		expect(result.payload).toEqual(['http://a', 'error', 'attempt', '2']);
		expect(result.extracted).toBeNull();
	});

	test('a "wait" href with attempt <= 6 -> RETRY_OK, promotes to queue, computes backoff delay', () => {
		const result = decideRetry(['http://a', 'wait', 'src:http://a', 'origin', 'attempt', '3']);
		expect(result.retry).toBe('RETRY_OK');
		expect(result.extracted).toBe('http://a');
		expect(result.promoteHref).toBe('http://a');
		expect(result.promoteSource).toBe('origin');
		expect(result.newAttempt).toBe('4');
		expect(result.delaySeconds).toBe(15); // 5 * previous attempt count (3)
		expect(result.payload).toEqual(['http://a', 'queue', 'src:http://a', 'origin', 'attempt', '4']);
	});

	test('a "wait" href with no existing attempt field -> initializes attempt to 1, delay 5', () => {
		const result = decideRetry(['http://b', 'wait']);
		expect(result.retry).toBe('RETRY_OK');
		expect(result.extracted).toBe('http://b');
		expect(result.promoteHref).toBe('http://b');
		expect(result.promoteSource).toBe(''); // no matching "src:" field -> empty
		expect(result.newAttempt).toBe('1');
		expect(result.delaySeconds).toBe(5);
		expect(result.payload).toEqual(['http://b', 'queue', 'attempt', '1']);
	});

	test('attempt > 6 -> gives up on promoting the wait href, but still errors a co-existing queue href', () => {
		const result = decideRetry(['http://c', 'queue', 'http://d', 'wait', 'attempt', '7']);
		expect(result.retry).toBe('RETRY_NOK'); // shouldRetry was false, so retry never flips to RETRY_OK
		expect(result.extracted).toBeNull();
		expect(result.errorHref).toBe('http://c');
		expect(result.payload).toEqual(['http://c', 'error', 'http://d', 'wait', 'attempt', '7']);
	});

	test('"error-nocache" blocks retry even under the attempt threshold', () => {
		const result = decideRetry(['http://e', 'wait', 'error-nocache', '1', 'attempt', '1']);
		expect(result.retry).toBe('RETRY_NOK');
		expect(result.extracted).toBeNull();
		expect(result.payload).toEqual(['http://e', 'wait', 'error-nocache', '1', 'attempt', '1']);
	});

	test('only the FIRST "wait" href in the array is ever considered', () => {
		const result = decideRetry(['http://first', 'wait', 'http://second', 'wait', 'attempt', '1']);
		expect(result.extracted).toBe('http://first');
		expect(result.promoteHref).toBe('http://first');
		// the second wait entry is left completely untouched
		expect(result.payload).toEqual(['http://first', 'queue', 'http://second', 'wait', 'attempt', '2']);
	});

	test('a "complete" entry seen before the first promotable "wait" overrides retry to RETRY_NONEED, but mutations from the wait branch still happened', () => {
		const result = decideRetry(['other', 'complete', 'http://f', 'wait', 'attempt', '2']);
		expect(result.retry).toBe('RETRY_NONEED');
		// the promotion still ran (the override only changes the returned `retry` verdict)
		expect(result.extracted).toBe('http://f');
		expect(result.promoteHref).toBe('http://f');
		expect(result.newAttempt).toBe('3');
		expect(result.delaySeconds).toBe(10);
		expect(result.payload).toEqual(['other', 'complete', 'http://f', 'queue', 'attempt', '3']);
		// no queue-href was scanned before the break, so nothing gets marked error
		expect(result.errorHref).toBe('');
	});

	test('a "complete" entry that appears only AFTER the first wait-with-href is never seen (loop already broke)', () => {
		const result = decideRetry(['http://g', 'wait', 'attempt', '1', 'unrelated', 'complete']);
		// the loop breaks at the wait entry (index 1) before reaching "complete" at index 5
		expect(result.retry).toBe('RETRY_OK');
	});

	test('"queue" only counts when the preceding element looks like an href (starts with "http")', () => {
		const result = decideRetry(['not-an-href', 'queue']);
		expect(result.errorHref).toBe('');
		expect(result.payload).toEqual(['not-an-href', 'queue']);
	});

	test('srcOf looks up the sibling "src:<href>" field regardless of array position', () => {
		const result = decideRetry(['src:http://h', 'from-cache', 'http://h', 'wait']);
		expect(result.promoteSource).toBe('from-cache');
	});
});
