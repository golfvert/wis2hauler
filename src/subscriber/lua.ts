// The Lua script the Subscriber EVALs against Redis for the
// "Exists" -> "Complete ?" -> "Set" chain (store.ts's isAlreadyComplete
// + claimDownload) -- previously two separate sequential round trips
// per message (EXISTS, then conditionally SET NX EX), combined here
// into one atomic server-side check, both to cut the round-trip count
// on SUBSCRIBER's own hot path and to close the small window that used
// to exist between the two separate calls (a second message for the
// same downloaderId could theoretically observe alreadyComplete=false
// from its own EXISTS before the first message's SET NX had landed).
// NOT a port of anything in flows.json -- the original does this as two
// separate nodes/round trips too; this is a from-scratch optimization
// added 2026-09-23 while investigating SUBSCRIBER's CPU cost (see
// consumer.ts's checkAndClaimDownload call site).
//
// Called as: EVAL(LUA_CHECK_AND_CLAIM, 2, downloaderCompleteKey(id), downloaderClaimKey(id), ttlSeconds)
// KEYS[1] = downloaderCompleteKey(downloaderId). KEYS[2] =
// downloaderClaimKey(downloaderId). ARGV[1] = ttlSeconds (900 in
// production, same as CLAIM_TTL_SECONDS).
//
// Returns {alreadyComplete, claimed} as a 2-element array of 0/1
// integers (RESP array of integers -- ioredis hands this back as a
// plain JS array, e.g. [0, 1]):
//   - complete key exists            -> {1, 0} (claimDownload's SET is
//     never even attempted, matching the original's "Complete ?"
//     switch gating the SET attempt out of the already-complete path)
//   - complete key absent, SET NX wins  -> {0, 1}
//   - complete key absent, SET NX loses -> {0, 0} (someone else already
//     claimed it)
export const LUA_CHECK_AND_CLAIM = `if redis.call('EXISTS',KEYS[1])==1 then return {1,0} end; if redis.call('SET',KEYS[2],'true','EX',ARGV[1],'NX') then return {0,1} end; return {0,0}`;
