// The Reporter tab's "Store" redis-lua-script node (b4b62b2a4c6e6e27)
// -- ported verbatim (character-for-character, matching lua.ts's own
// precedent for how this project ports Lua). A sliding-window distinct-IP
// counter: removes any IP whose score (its last-seen Redis TIME, in
// seconds) has fallen out of the `window` (ARGV[2], seconds) trailing
// window, re-adds/refreshes the current IP at the current time, then
// returns the ZCARD (distinct count) of whatever remains.
//
// Called as: EVAL(LUA_ACTIVE_IPS, 1, reporterActiveIpsKey(), ip, String(keepIpSeconds))
// KEYS[1] = the active-ips ZSET. ARGV[1] = the client IP. ARGV[2] =
// the trailing window in seconds (config.reporter['keep-ip-address'],
// default 86400 -- see run.ts).
export const LUA_ACTIVE_IPS = `local key    = KEYS[1]
local ip     = ARGV[1]
local window = ARGV[2]

local time = redis.call('TIME')
local now  = tonumber(time[1])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
redis.call('ZADD', key, now, ip)

return redis.call('ZCARD', key)`;
