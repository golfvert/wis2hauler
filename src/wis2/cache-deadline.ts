import type { Config } from '../config/schema.ts';

/** The WIS2 Guide gives a Global Cache 10 minutes to cache a new or updated notification. */
export const DEFAULT_CACHE_DEADLINE_SECONDS = 600;

/** `global.cache-deadline`, in seconds. */
export function cacheDeadlineSeconds(config: Config): number {
	return config.global['cache-deadline'] ?? DEFAULT_CACHE_DEADLINE_SECONDS;
}
