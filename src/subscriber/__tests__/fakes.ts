// Shared in-memory fakes for SubscriberStore and MqttLike, used by
// ingest.test.ts and consumer.test.ts so the pipeline orchestration
// (ingest.ts, consumer.ts) can be exercised without a live Redis or
// MQTT broker -- same dependency-injection approach the rest of this
// codebase uses to keep business logic unit-testable.
//
// Modeled after the real Redis shapes store.ts now documents (one
// hash per downloader_id, fields keyed by literal Redis field names
// including the href-as-field-name oddity) rather than the earlier
// DownloadJob/Waiter design, so assertions here read the same way a
// real `HGETALL wis2gc:downloader:downloader_id:X` would.
import type { RawStreamEntry, SubscriberStore } from '../store.ts';
import type { MqttLike } from '../../mqtt/types.ts';

export class FakeStore implements SubscriberStore {
	messageIds = new Set<string>();
	rawStream: RawStreamEntry[] = [];
	completeIds = new Set<string>();
	claimedIds = new Set<string>();
	/** One entry per downloader_id hash, fields exactly as HSET would store them. */
	hashes = new Map<string, Record<string, string>>();
	expirations = new Map<string, number>();
	workQueue: { queue: string; downloaderId: string; href: string; topic: string; content: boolean }[] = [];
	releasedClaims: string[] = [];
	private nextStreamId = 0;

	async claimMessageId(wnmId: string): Promise<boolean> {
		if (this.messageIds.has(wnmId)) return false;
		this.messageIds.add(wnmId);
		return true;
	}

	async appendRawMessage(_queue: string, topic: string, payload: string, _timestampMs: number): Promise<string> {
		const id = `${++this.nextStreamId}-0`;
		this.rawStream.push({ id, topic, payload });
		return id;
	}

	async readRawMessages(_queue: string, _lastId: string, _count: number): Promise<RawStreamEntry[]> {
		return [];
	}

	async isAlreadyComplete(downloaderId: string): Promise<boolean> {
		return this.completeIds.has(downloaderId);
	}

	async claimDownload(downloaderId: string): Promise<boolean> {
		if (this.claimedIds.has(downloaderId)) return false;
		this.claimedIds.add(downloaderId);
		return true;
	}

	private hashFor(downloaderId: string): Record<string, string> {
		let h = this.hashes.get(downloaderId);
		if (!h) {
			h = {};
			this.hashes.set(downloaderId, h);
		}
		return h;
	}

	async initAttempt(downloaderId: string): Promise<void> {
		this.hashFor(downloaderId).attempt = '1';
	}

	async writeDownloadJob(downloaderId: string, href: string, source: string, wnmJson: string, topic: string, published: string): Promise<void> {
		const h = this.hashFor(downloaderId);
		h[href] = 'queue';
		h[`src:${href}`] = source;
		h.wnm = wnmJson;
		h.topic = topic;
		h.published = published;
		h.attempt = '1';
		this.expirations.set(downloaderId, 7200);
	}

	async enqueueWork(queue: string, downloaderId: string, href: string, topic: string, content: boolean): Promise<void> {
		this.workQueue.push({ queue, downloaderId, href, topic, content });
	}

	async recordWait(downloaderId: string, href: string, source: string): Promise<void> {
		const h = this.hashFor(downloaderId);
		h[href] = 'wait';
		h[`src:${href}`] = source;
	}

	async releaseClaim(downloaderId: string): Promise<void> {
		this.releasedClaims.push(downloaderId);
	}

	async quit(): Promise<void> {}
}

export class FakeMqtt implements MqttLike {
	subscribedTopics: string[] = [];
	published: { topic: string; payload: string }[] = [];
	private handler: ((topic: string, payload: Buffer) => void) | undefined;

	async subscribe(topics: readonly string[]): Promise<void> {
		this.subscribedTopics.push(...topics);
	}

	onMessage(handler: (topic: string, payload: Buffer) => void): void {
		this.handler = handler;
	}

	async publish(topic: string, payload: string): Promise<void> {
		this.published.push({ topic, payload });
	}

	async end(): Promise<void> {}

	// Test helper: simulate an inbound message arriving on this connection.
	emit(topic: string, payload: string): void {
		this.handler?.(topic, Buffer.from(payload, 'utf8'));
	}
}
