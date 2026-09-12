// Real MqttLike, backed by mqtt.js. One connection per BrokerConfig —
// used for each of Subscriber's GB1/GB2 upstream brokers, and for
// each of global.local-broker's PUB1/PUB2 targets that publish-only
// outcomes republish onto.
import mqtt, { type MqttClient } from 'mqtt';
import type { BrokerConfig } from '../config/schema.ts';
import type { MqttLike } from './types.ts';

function wrapMqttClient(client: MqttClient): MqttLike {
	return {
		subscribe(topics) {
			return new Promise((res, rej) => {
				client.subscribe([...topics], { qos: 1 }, (err) => (err ? rej(err) : res()));
			});
		},
		onMessage(handler) {
			client.on('message', (topic, payload) => handler(topic, payload));
		},
		publish(topic, payload) {
			// Fail fast instead of hanging: mqtt.js queues a QoS>0
			// publish while offline and only invokes its callback once
			// the message is actually sent and acked -- for a
			// connectMqttBestEffort client (below) whose broker may
			// simply never come back, that callback could otherwise
			// never fire. Rejecting immediately when not currently
			// connected means "can't connect" and "was connected, then
			// dropped" are handled identically: callers (subscriber/
			// consumer.ts's publish-only case, downloader/finishing.ts)
			// already catch and log-and-continue per message/job, so
			// this turns a possible silent stall into that same bounded,
			// already-handled error path.
			if (!client.connected) {
				return Promise.reject(new Error(`mqtt client not connected (cannot publish to ${topic})`));
			}
			return new Promise((res, rej) => {
				client.publish(topic, payload, { qos: 1 }, (err) => (err ? rej(err) : res()));
			});
		},
		end() {
			// force:true (not false) -- mqtt.js's own well-documented
			// gotcha: end(false, ...)'s callback waits for a graceful
			// MQTT DISCONNECT over a live connection, but if the
			// client happens to be mid-reconnect/backoff (reconnectPeriod
			// above) when shutdown is requested, there's no live
			// connection to gracefully close over and the callback can
			// simply never fire -- observed live (the maintainer: SIGINT/Ctrl-C
			// does nothing, only kill -9 works) since main.ts's shutdown
			// path awaits every client's end() before the process can
			// exit. force closes the underlying socket immediately
			// regardless of connection state, so this always resolves.
			// It also stops mqtt.js's own reconnect loop, so a
			// connectMqttBestEffort client that's mid-retry in the
			// background stops cleanly too.
			return new Promise((res) => client.end(true, {}, () => res()));
		},
	};
}

// GB1/GB2 (Subscriber's actual upstream data source) -- blocking until
// connected is the right behavior here: there is nothing useful for
// Subscriber to do without it, so it retries forever (reconnectPeriod)
// and the caller awaits that.
//
// `label` is a role tag for log lines only (e.g. "GB1", "PUB2") --
// see connectMqttBestEffort's logOutageOnce below. `clientId` is the
// actual MQTT client id put on the wire; per the maintainer's request ("use the
// centre-id - worker name"), the caller (main.ts -- see its
// DELIBERATE CHANGE, 2026-09-12 comment) builds it from
// `${centre-id}-${worker}`, plus this connection's own `label`
// appended for uniqueness. That suffix isn't optional: a replica can
// run SUBSCRIBER with two GB brokers (GB1/GB2), and PUB1/PUB2 is
// shared with DOWNLOADER when both are active on the SAME replica --
// `centre-id-worker` alone would hand two simultaneous connections to
// the same broker the identical client id -- the MQTT spec has the
// broker disconnect whichever connection held that id first, so the
// two connections would fight each other in an endless kick/reconnect
// loop. Keeping `label` in the id (GB1 vs GB2, PUB1 vs PUB2) keeps
// every connection this process opens unique per broker. main.ts is
// now the ONLY caller of connectMqtt/connectMqttBestEffort -- it owns
// every MQTT connection this process makes, opening PUB1/PUB2 once
// and handing the same client instances to whichever of SUBSCRIBER/
// DOWNLOADER are active, rather than each role dialing its own (see
// main.ts's RoleRunners doc comment).
export function connectMqtt(broker: BrokerConfig, label: string, clientId: string): Promise<MqttLike> {
	return new Promise((resolve, reject) => {
		const client: MqttClient = mqtt.connect(broker.broker, {
			username: broker.username,
			password: broker.password,
			protocolVersion: broker.version ?? 5,
			rejectUnauthorized: broker.verifycert ?? true,
			clientId,
			reconnectPeriod: 5000,
		});

		client.once('connect', () => resolve(wrapMqttClient(client)));
		client.once('error', (err) => reject(err));
	});
}

// PUB1/PUB2 (global.local-broker) -- these are publish-only outcome
// sinks (cache/monitor topic republish, cleaner-report notifications),
// not required for the subscribe/download loop itself to run. Used by
// both DOWNLOADER and SUBSCRIBER's run.ts. Unlike connectMqtt above,
// this must NEVER block its caller indefinitely, whether the broker
// can't be reached at all yet, or was reachable and then dropped --
// observed live (the maintainer, 2026-09-10): an unreachable local-broker
// hostname (a Docker Compose service name not resolvable from a
// natively-run process, the same class of issue as the aria-url fix)
// left DOWNLOADER/SUBSCRIBER stuck forever at "connecting to PUB1",
// never reaching the actual consumer loop, so nothing ever got
// downloaded and nothing was ever logged.
//
// Design: this always resolves with a usable MqttLike, within
// `initialTimeoutMs` (bounded by mqtt.js's own connectTimeout and our
// own setTimeout as a hard backstop regardless of what stage the
// underlying connection is stuck at, e.g. a hung DNS lookup) -- never
// with null, never left hanging. If the broker isn't up yet, that's
// logged once and the caller proceeds with a client that currently
// can't publish (see wrapMqttClient's publish() guard above, which
// fails fast rather than queuing forever). reconnectPeriod stays at
// the normal 5000ms *after* the initial wait, so mqtt.js keeps
// retrying in the background indefinitely -- no code here has to poll
// or retry anything itself, and publish() simply starts working again
// on its own once the broker becomes reachable (client.connected flips
// back to true). Each new outage (first failure, or a later drop) logs
// exactly one error, not one per 5s retry attempt.
const DEFAULT_LOCAL_BROKER_CONNECT_TIMEOUT_MS = 5000;

export function connectMqttBestEffort(
	broker: BrokerConfig,
	label: string,
	clientId: string,
	log: Pick<typeof console, 'error'>,
	initialTimeoutMs: number = DEFAULT_LOCAL_BROKER_CONNECT_TIMEOUT_MS,
): Promise<MqttLike> {
	return new Promise((resolve) => {
		let settledInitial = false;
		let loggedCurrentOutage = false;

		const client: MqttClient = mqtt.connect(broker.broker, {
			username: broker.username,
			password: broker.password,
			protocolVersion: broker.version ?? 5,
			rejectUnauthorized: broker.verifycert ?? true,
			clientId,
			connectTimeout: initialTimeoutMs,
			reconnectPeriod: 5000,
		});

		const wrapper = wrapMqttClient(client);

		const finishInitialWait = () => {
			if (settledInitial) return;
			settledInitial = true;
			clearTimeout(timer);
			resolve(wrapper);
		};

		const logOutageOnce = (reason: string) => {
			if (loggedCurrentOutage) return;
			loggedCurrentOutage = true;
			log.error(`local-broker ${label} (${broker.broker}) unreachable, continuing without it (will keep retrying in the background): ${reason}`);
		};

		const timer = setTimeout(() => {
			logOutageOnce(`no response within ${initialTimeoutMs}ms`);
			finishInitialWait();
		}, initialTimeoutMs);

		client.on('connect', () => {
			loggedCurrentOutage = false; // recovered -- the next drop gets its own log line
			finishInitialWait();
		});
		client.on('error', (err) => {
			logOutageOnce(err instanceof Error ? err.message : String(err));
			finishInitialWait();
		});
	});
}
