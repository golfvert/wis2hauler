// Port of the "Credentials" 10s sync (cred-sync-inject -> "Ready ?" ->
// HGETALL downloaderCredentialsKey() -> "Credentials" function,
// cred-sync-update) plus the Setup tab's one-time startup seed
// ("Credentials" function cred-config-prep -> "HSET" cred-config-hset,
// tab 1c6759660a32fda5 -- a DIFFERENT tab from the Downloader one this
// phase otherwise ports, traced separately this session since
// downloaderCredentialsKey's own doc comment in redis-keys.ts already
// promised it). Keeps an in-memory topic -> {username,password} map
// that aria-start.ts's addUri calls read from.
//
// cred-config-prep's sibling function (02a4f430ad19de4e, same tab)
// handles a live create/update/delete admin operation on individual
// credential entries -- that's now implemented too, as ../downloader/
// store.ts's setCredential/deleteCredential, called from ../admin/
// set.ts's applyCredentialsOp (the POST /set admin-API handler). Kept
// out of THIS file since it's an admin-API concern, not part of the
// Downloader tab's own 10s poll/startup-seed loop this file ports.
import type { DownloaderStore } from './store.ts';

export type CredentialMap = Readonly<Record<string, { username: string; password: string }>>;

/**
 * "Credentials" (cred-sync-update): parses each field's value as JSON,
 * skipping (and warning on) any that fail to parse. The original
 * defensively handles BOTH an array-shaped and an object-shaped
 * payload -- store.getCredentials() always returns the flat array
 * shape (see store.ts), so only that branch is ported; the
 * object-shaped branch never applies to this store's return type.
 */
export function parseCredentials(flat: readonly string[], warn: (message: string) => void): CredentialMap {
	const creds: Record<string, { username: string; password: string }> = {};
	for (let i = 0; i < flat.length; i += 2) {
		const field = flat[i];
		if (field === undefined) continue;
		try {
			creds[field] = JSON.parse(flat[i + 1] ?? '') as { username: string; password: string };
		} catch {
			warn(`download-creds: failed to parse '${field}'`);
		}
	}
	return creds;
}

export async function pollCredentials(store: DownloaderStore, warn: (message: string) => void): Promise<CredentialMap> {
	const flat = await store.getCredentials();
	return parseCredentials(flat, warn);
}

/**
 * "Credentials" (cred-config-prep) -> "HSET" (cred-config-hset): the
 * one-time startup seed from config.downloader.credentials -- a no-op
 * when there are no configured credentials at all (matching the
 * original's `if (!creds || ... Object.keys(creds).length === 0)
 * return null;` early exit, which never issues the HSET).
 */
export async function seedCredentials(store: DownloaderStore, credentials: CredentialMap | undefined): Promise<void> {
	if (!credentials || Object.keys(credentials).length === 0) return;
	await store.seedCredentials(credentials);
}
