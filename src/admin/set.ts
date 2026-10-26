// The Setup tab's "Updates" function node (POST /set): validates a
// patch body (../config/runtime.ts's validatePatch, ported separately
// since it's also reusable on its own), applies the in-memory keys to
// ../admin/runtime-store.ts's RuntimeConfigStore, and -- for
// 'credentials' only, which that store deliberately does NOT own (see
// its own header) -- applies a real Redis HSET/HDEL via ../downloader/
// store.ts's setCredential/deleteCredential. Response shape is the
// original's exactly: {changes: {key: {value,changed}}, errors?}.
import type { Role } from '../config/schema.ts';
import { validatePatch, type CredentialOp } from '../config/runtime.ts';
import type { RuntimeConfigStore, ChangeEntry } from './runtime-store.ts';
import type { DownloaderStore } from '../downloader/store.ts';
import { parseCredentials } from '../downloader/credentials.ts';

export interface SetContext {
	store: RuntimeConfigStore;
	// Only present on a replica carrying DOWNLOADER -- see ../get.ts's
	// GetContext doc comment, same reasoning.
	credentialsStore: DownloaderStore | null;
	warn: (message: string) => void;
}

export interface SetResult {
	status: 200 | 400;
	body: { changes: Record<string, ChangeEntry>; errors?: string[]; warnings?: string[] };
}

/**
 * "Credentials" (02a4f430ad19de4e): create/update HSETs the topic's
 * JSON-encoded {username,password}, delete HDELs it. `changed` is
 * computed by reading the map back first -- the original's own
 * "changed" comparison is generic across all patchable keys (see
 * runtime-store.ts's applyPatch), so this mirrors that here for the
 * one key that store doesn't handle itself. The response value omits
 * `password` deliberately (a hygiene addition, not in the original,
 * which doesn't sanitize its response) -- the topic and username are
 * enough to confirm what changed.
 */
async function applyCredentialsOp(store: DownloaderStore | null, op: CredentialOp, warn: (message: string) => void): Promise<ChangeEntry> {
	if (!store) {
		warn(`credentials: DOWNLOADER role not active on this replica -- no store to apply '${op.topic}' against.`);
		return { value: { topic: op.topic }, changed: false };
	}

	const before = parseCredentials(await store.getCredentials(), warn);

	if (op.op === 'delete') {
		const existed = before[op.topic] !== undefined;
		await store.deleteCredential(op.topic);
		return { value: { op: 'delete', topic: op.topic }, changed: existed };
	}

	const previous = before[op.topic];
	await store.setCredential(op.topic, { username: op.username, password: op.password });
	const changed = !previous || previous.username !== op.username || previous.password !== op.password;
	return { value: { op: op.op, topic: op.topic, username: op.username }, changed };
}

export async function buildSetResponse(body: unknown, activeRoles: ReadonlySet<Role>, ctx: SetContext): Promise<SetResult> {
	const patch = validatePatch(body, activeRoles);
	for (const d of patch.deprecated ?? []) ctx.warn(d);
	const changes = ctx.store.applyPatch(patch.values);

	if (patch.values.credentials) {
		changes.credentials = await applyCredentialsOp(ctx.credentialsStore, patch.values.credentials, ctx.warn);
	}

	const hasChanges = Object.keys(changes).length > 0;
	return {
		status: hasChanges ? 200 : 400,
		body: {
			changes,
			...(patch.errors.length > 0 ? { errors: patch.errors } : {}),
			...(patch.deprecated ? { warnings: patch.deprecated } : {}),
		},
	};
}
