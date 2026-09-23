// NOT CURRENTLY USED -- see ioredis-store.ts's checkAndClaimDownload's
// own "REVERTED, 2026-09-23" comment for the full story: this script
// combines EXISTS on downloaderCompleteKey(id) and a conditional SET NX
// EX on downloaderClaimKey(id) into one EVAL, which requires BOTH keys
// to hash to the same Redis Cluster slot. They don't (no shared hash
// tag), so this throws "CROSSSLOT Keys in request don't hash to the
// same slot" on every call against a real `redis.mode: cluster`
// deployment -- confirmed live, 2026-09-23, blocking every download
// fleet-wide for however long this was deployed. DO NOT wire this back
// in as-is. A cluster-safe version would need downloaderCompleteKey and
// downloaderClaimKey to share a `{downloaderId}` hash tag (redis-keys.ts),
// which is itself a live-key-format change needing its own migration/
// compatibility pass (existing in-flight claims/completions under the
// OLD key strings would go temporarily invisible to the new code until
// their TTL expires) -- not something to redo under incident pressure.
// Kept here, unused, only so the next attempt starts from a documented
// cause of death rather than repeating it.
//
// Original doc comment, for reference:
//
// Called as: EVAL(LUA_CHECK_AND_CLAIM, 2, downloaderCompleteKey(id), downloaderClaimKey(id), ttlSeconds)
// KEYS[1] = downloaderCompleteKey(downloaderId). KEYS[2] =
// downloaderClaimKey(downloaderId). ARGV[1] = ttlSeconds (900 in
// production, same as CLAIM_TTL_SECONDS).
//
// Returns {alreadyComplete, claimed} as a 2-element array of 0/1
// integers:
//   - complete key exists                -> {1, 0}
//   - complete key absent, SET NX wins   -> {0, 1}
//   - complete key absent, SET NX loses  -> {0, 0}
export const LUA_CHECK_AND_CLAIM = `if redis.call('EXISTS',KEYS[1])==1 then return {1,0} end; if redis.call('SET',KEYS[2],'true','EX',ARGV[1],'NX') then return {0,1} end; return {0,0}`;
