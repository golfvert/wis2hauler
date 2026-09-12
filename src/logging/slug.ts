// Ported verbatim from the Setup tab's three "Log" change nodes
// (244b379575d5653c / b4eda2dd5f255c3c / aefeea0d2c59acde), which each
// build `_logIO_.fileName` as:
//   "wis2gc-" & $replace($lowercase(sourceNode), /[^a-z]/, "") & "-%DATE%.<level>.log"
// `sourceNode` there was the name of whichever node most recently
// touched the message (traced via the maintainer's own @golfvert/node-red-
// previous-node, itself un-configured -- see the session's logging
// analysis for the full trace). In this port there's no node object,
// so `createSourceLogger(name)` (logger.ts) takes an explicit name and
// slugifies it the same way flows.json did.
export function slugifySource(name: string): string {
	return name.toLowerCase().replace(/[^a-z]/g, '');
}
