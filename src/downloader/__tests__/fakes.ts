// Shared in-memory fake DownloaderStore + fake Aria2Client-shaped
// helpers for the Downloader test suite -- same DI approach as
// subscriber/__tests__/fakes.ts's FakeStore.
import type { DownloaderStore, StreamRegistration, WorkerCommandEntry, WorkQueueEntry } from '../store.ts';

function flatten(record: Record<string, string>): string[] {
	const out: string[] = [];
	for (const [k, v] of Object.entries(record)) out.push(k, v);
	return out;
}

export class FakeDownloaderStore implements DownloaderStore {
	queueLengths = new Map<string, number>();
	workQueues = new Map<string, WorkQueueEntry[]>();
	hashes = new Map<string, Record<string, string>>();
	streamEntries = new Map<string, StreamRegistration>();
	streamExpires = new Set<string>();
	aria2GidRecords = new Map<string, string[]>();
	acked: { queue: string; entryId: string }[] = [];
	xdeleted: { queue: string; entryId: string }[] = [];
	deletedStreamEntries: string[] = [];
	deletedStreamEntryExpires: string[] = [];
	deletedAria2GidRecords: string[] = [];
	deletedAria2GidExpires: string[] = [];
	cancelSchedule = new Map<string, number>();
	cleanerReports: { worker: string; report: string }[] = [];
	errors: { queue: string; worker: string; payload: string }[] = [];
	credentials: Record<string, string> = {};
	infoGranules: { uri: string; length: string; centreid: string; topic: string }[] = [];
	workerCommandStreams = new Map<string, WorkerCommandEntry[]>();
	trimmedTo = new Map<string, string>();
	completeIds = new Set<string>();
	quitCalled = false;
	ensuredWorkQueueGroups: string[] = [];

	private hashFor(downloaderId: string): Record<string, string> {
		let h = this.hashes.get(downloaderId);
		if (!h) {
			h = {};
			this.hashes.set(downloaderId, h);
		}
		return h;
	}

	async getQueueLength(queue: string): Promise<number> {
		return this.queueLengths.get(queue) ?? 0;
	}

	async readWorkQueue(queue: string, _worker: string, count: number): Promise<WorkQueueEntry[]> {
		const list = this.workQueues.get(queue) ?? [];
		const taken = list.splice(0, count);
		return taken;
	}

	async ensureWorkQueueGroup(queue: string): Promise<void> {
		this.ensuredWorkQueueGroups.push(queue);
	}

	async getDownloaderRecord(downloaderId: string): Promise<string[]> {
		return flatten(this.hashFor(downloaderId));
	}

	async registerStreamEntry(worker: string, streamId: string, fields: StreamRegistration): Promise<void> {
		this.streamEntries.set(`${worker}:${streamId}`, fields);
	}

	async expireStreamEntry(worker: string, streamId: string): Promise<void> {
		this.streamExpires.add(`${worker}:${streamId}`);
	}

	async getStreamEntry(worker: string, streamId: string): Promise<string[]> {
		const fields = this.streamEntries.get(`${worker}:${streamId}`);
		if (!fields) return [];
		return [
			'stream_id',
			fields.streamId,
			'downloader_id',
			fields.downloaderId,
			'download_entry_id',
			fields.downloadEntryId,
			'href',
			fields.href,
			'filename',
			fields.filename,
		];
	}

	async setAria2GidFields(worker: string, gid: string, flatFields: readonly string[]): Promise<void> {
		this.aria2GidRecords.set(`${worker}:${gid}`, [...flatFields]);
	}

	async getAria2GidRecord(worker: string, gid: string): Promise<string[]> {
		return this.aria2GidRecords.get(`${worker}:${gid}`) ?? [];
	}

	async ackWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		this.acked.push({ queue, entryId });
	}

	async deleteWorkQueueEntry(queue: string, entryId: string): Promise<void> {
		this.xdeleted.push({ queue, entryId });
	}

	async deleteStreamEntry(worker: string, streamId: string): Promise<void> {
		this.deletedStreamEntries.push(`${worker}:${streamId}`);
		this.streamEntries.delete(`${worker}:${streamId}`);
	}

	async deleteStreamEntryExpire(worker: string, streamId: string): Promise<void> {
		this.deletedStreamEntryExpires.push(`${worker}:${streamId}`);
		this.streamExpires.delete(`${worker}:${streamId}`);
	}

	async deleteAria2GidRecord(worker: string, gid: string): Promise<void> {
		this.deletedAria2GidRecords.push(`${worker}:${gid}`);
		this.aria2GidRecords.delete(`${worker}:${gid}`);
	}

	async deleteAria2GidExpire(worker: string, gid: string): Promise<void> {
		this.deletedAria2GidExpires.push(`${worker}:${gid}`);
	}

	async scheduleCleanerCancel(worker: string, gid: string): Promise<void> {
		this.cancelSchedule.set(`${worker}|${gid}`, Date.now() + 420000);
	}

	async unscheduleCleanerCancel(worker: string, gid: string): Promise<void> {
		this.cancelSchedule.delete(`${worker}|${gid}`);
	}

	async publishCleanerReport(worker: string, report: string): Promise<void> {
		this.cleanerReports.push({ worker, report });
	}

	async recordError(queue: string, worker: string, errorPayload: string): Promise<void> {
		this.errors.push({ queue, worker, payload: errorPayload });
	}

	async getCredentials(): Promise<string[]> {
		return flatten(this.credentials);
	}

	async seedCredentials(entries: Readonly<Record<string, { username: string; password: string }>>): Promise<void> {
		for (const [topic, val] of Object.entries(entries)) this.credentials[topic] = JSON.stringify(val);
	}

	async setCredential(topic: string, entry: { username: string; password: string }): Promise<void> {
		this.credentials[topic] = JSON.stringify(entry);
	}

	async deleteCredential(topic: string): Promise<void> {
		delete this.credentials[topic];
	}

	async completeHref(downloaderId: string, href: string, storedAtMillis: string, localHref: string): Promise<'complete' | null> {
		const h = this.hashFor(downloaderId);
		const current = h[href];
		if (current === undefined) return null;
		if (current === 'complete') return 'complete';
		h[href] = 'complete';
		h.stored = storedAtMillis;
		h.link = localHref;
		return 'complete';
	}

	async retryTransition(
		downloaderId: string,
		promoteHref: string,
		_promoteSource: string,
		newAttempt: string,
		errorHref: string,
		_errorSource: string,
	): Promise<number> {
		const h = this.hashFor(downloaderId);
		if (errorHref !== '') {
			if (h[errorHref] === 'queue') h[errorHref] = 'error';
		}
		if (promoteHref !== '') {
			if (h[promoteHref] === 'wait') {
				h[promoteHref] = 'queue';
				h.attempt = newAttempt;
				return 1;
			}
			return 0;
		}
		return 0;
	}

	async recordInfoGranule(uri: string, length: string, centreid: string, topic: string): Promise<void> {
		this.infoGranules.push({ uri, length, centreid, topic });
	}

	async pollCommands(worker: string, lastId: string, count: number): Promise<WorkerCommandEntry[]> {
		const list = this.workerCommandStreams.get(worker) ?? [];
		return list.filter((e) => e.id > lastId).slice(0, count);
	}

	async trimCommands(worker: string, minId: string): Promise<void> {
		this.trimmedTo.set(worker, minId);
	}

	async markDownloadComplete(downloaderId: string): Promise<void> {
		this.completeIds.add(downloaderId);
	}

	async quit(): Promise<void> {
		this.quitCalled = true;
	}
}
