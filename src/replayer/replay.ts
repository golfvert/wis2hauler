// The Replayer tab's replay-request chain: "Extract" (e3b0788194a2af48)
// builds the POST body/headers/url; the upstream "split" node
// (6763858aa9b000e7, splitting msg.topics -- an ARRAY at this point,
// so Node-RED's split node emits one message per element regardless of
// its configured string-split settings) and "Limit" delay node
// (3cec953a894907bf, pauseType "rate": 1 message per 10 seconds,
// drop:false so excess messages queue rather than get dropped) fan out
// ONE request per discovered topic, rate-limited. The node's leftover
// timeout/randomFirst/randomLast fields belong to OTHER pauseType
// modes (Node-RED keeps a delay node's full config across UI mode
// switches) and don't apply while pauseType is "rate" -- not ported,
// since inventing what they'd do here would be guessing at Node-RED's
// internals, not reading flows.json's declared behavior.
//
// NOT WIRED to any live caller (this session's exact instruction,
// same "build the pure decision, defer the live hookup" precedent
// used elsewhere): the "Replayer" link-in (97a4f0f2771ea2b3) that
// feeds this chain is only ever reached from a link-out
// (f088edce0c3f6a60) living in the Setup tab's not-yet-built admin
// HTTP API (replay-request validation) -- out of scope for this
// phase. triggerReplay() below is exported and ready for that future
// phase to call.
import { discoverReplayTopics } from './discovery.ts';

export interface ReplayRequest {
	method: 'POST';
	url: string;
	headers: readonly string[];
	body: string;
}

/** "Extract" change node: POST url=global-replay-url, body {inputs:{datetime:"<from>/<to>", "subscriber-id":uuid, topic}} -- `topic` (singular) even though the field carrying it is `msg.topics` post-split, ported exactly as named in the original JSONata. */
export function buildReplayRequest(topic: string, from: string, to: string, uuid: string, globalReplayUrl: string): ReplayRequest {
	return {
		method: 'POST',
		url: globalReplayUrl,
		headers: ['accept: application/json', 'Content-Type: application/json'],
		body: JSON.stringify({ inputs: { datetime: `${from}/${to}`, 'subscriber-id': uuid, topic } }),
	};
}

// "Limit" delay node: pauseType "rate", 1 message per 10 seconds.
export const REPLAY_RATE_LIMIT_MS = 10000;

export interface ReplayTriggerDeps {
	readElectionHash(): Promise<string[]>;
	globalReplayUrl: string;
	uuid: string;
	postReplayRequest(req: ReplayRequest): Promise<void>;
	sleep(ms: number): Promise<void>;
	now?: () => number;
}

/** Discovers every currently-subscribed, not-already-replayed topic (discovery.ts) and POSTs one replay request per topic to globalReplayUrl, spaced REPLAY_RATE_LIMIT_MS apart (matching the "Limit" node's 1-per-10s rate, queued not dropped). `from`/`to` are the ISO datetime bounds the (not-yet-built) admin API would supply -- see this file's header. */
export async function triggerReplay(deps: ReplayTriggerDeps, from: string, to: string): Promise<void> {
	const flat = await deps.readElectionHash();
	const topics = discoverReplayTopics(flat, (deps.now ?? Date.now)());

	for (let i = 0; i < topics.length; i++) {
		if (i > 0) await deps.sleep(REPLAY_RATE_LIMIT_MS);
		const req = buildReplayRequest(topics[i]!, from, to, deps.uuid, deps.globalReplayUrl);
		await deps.postReplayRequest(req);
	}
}
