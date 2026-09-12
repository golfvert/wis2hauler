// The two Lua scripts the Downloader EVALs against Redis for atomic
// hash-record transitions. Ported verbatim (character-for-character
// logic, not just "equivalent") from the Node-RED "Load Lua" change
// node (Setup tab is NOT where this lives -- it's Downloader tab id
// ad3831085d2c14c9), which sets flow.luaComplete / flow.luaRetry as
// plain string constants. The original re-sends the full script text
// on every EVAL (command "EVAL", not "EVALSHA" -- there is no
// SCRIPT LOAD/caching in the original), so this port does the same:
// call ioredis's .eval(script, numkeys, ...keys, ...args) directly,
// no SHA caching needed to match behavior (ioredis may cache it for
// us internally, which is an implementation detail, not new behavior).

// Called as: EVAL(LUA_COMPLETE, 1, downloaderHashKey(downloaderId), href, storedAtMillis, localHref)
// KEYS[1] = the downloader_id hash. ARGV[1] = href. ARGV[2] = the
// millis timestamp string to record as "stored". ARGV[3] = the local
// file path/URL to record as "link".
//
// Returns Redis nil (Lua `false`) if the href field doesn't exist on
// the hash at all -- the original's "Payload ?" gate then drops the
// whole Finishing chain (no republish, no cleaner-reporter PUBLISH).
// Returns the string "complete" both when this call is the one that
// transitions the field to 'complete' AND when the field was already
// 'complete' (idempotent replay) -- both cases proceed through the
// Finishing chain identically; ported as-is, not "fixed" to skip the
// republish on the idempotent case.
export const LUA_COMPLETE = `local c=redis.call('HGET',KEYS[1],ARGV[1]); if not c then return false end; if c=='complete' then return 'complete' end; redis.call('HSET',KEYS[1],ARGV[1],'complete','stored',ARGV[2],'link',ARGV[3]); return 'complete'`;

// Called as: EVAL(LUA_RETRY, 1, downloaderHashKey(downloaderId), promoteHref, promoteSource, newAttempt, errorHref, errorSource)
// KEYS[1] = the downloader_id hash. ARGV[1] = promoteHref (the href
// being promoted from 'wait' to 'queue', or '' if none).
// ARGV[2] = promoteSource -- NOT read by the script (dead argument in
// the original; kept in the same ARGV position anyway so ARGV[3]/[4]
// don't shift). ARGV[3] = newAttempt, written as the promoted href's
// "attempt" field. ARGV[4] = errorHref (the href to demote from
// 'queue' to 'error', or ''). ARGV[5] = errorSource -- also unused by
// the script, kept for the same positional reason.
//
// Re-checks current state under a fresh HGET before writing (a
// decideRetry() snapshot can be stale by the time this runs): only
// demotes errorHref if it is STILL 'queue' (a concurrent success
// shouldn't be stomped back to 'error'), and only promotes promoteHref
// if it is STILL 'wait'. Returns 1 if the promotion happened, 0
// otherwise (including when promoteHref is '').
export const LUA_RETRY = `if ARGV[4]~='' then local e=redis.call('HGET',KEYS[1],ARGV[4]); if e and e=='queue' then redis.call('HSET',KEYS[1],ARGV[4],'error') end end; if ARGV[1]~='' then local w=redis.call('HGET',KEYS[1],ARGV[1]); if w and w=='wait' then redis.call('HSET',KEYS[1],ARGV[1],'queue','attempt',ARGV[3]); return 1 end; return 0 end; return 0`;

// Called as: EVAL(LUA_HSET_EXPIRE, 1, key, field1, value1, field2, value2, ...)
// Ported from the "HSET / Lua" redis-lua-script node (057037c9713eb43f,
// used by the "Info" step at the end of a successful download): HSETs
// every field/value ARGV pair onto KEYS[1], then unconditionally
// EXPIREs that key 86400 seconds -- a plain redis-lua-script node's
// `func` body IS the script (no wrapping needed, unlike the two
// EVAL-command scripts above which are full `local ... return ...`
// snippets built by hand).
export const LUA_HSET_EXPIRE = `for i = 1, #ARGV - 1, 2 do\n  redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1])\nend\nredis.call('EXPIRE', KEYS[1], 86400)\nreturn redis.status_reply('OK')`;
