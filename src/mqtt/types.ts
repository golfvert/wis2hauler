// Narrow MQTT client surface the pipeline actually uses, kept
// separate from the real mqtt.js client so ingest.ts/consumer.ts can
// be unit tested against a fake in-memory broker instead of a live
// one — same reasoning as subscriber/store.ts's SubscriberStore.
export interface MqttLike {
	subscribe(topics: readonly string[]): Promise<void>;
	onMessage(handler: (topic: string, payload: Buffer) => void): void;
	publish(topic: string, payload: string): Promise<void>;
	end(): Promise<void>;
}
