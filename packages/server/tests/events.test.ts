import { describe, expect, it } from "vitest";
import { EventBus, type ServerEvent } from "../src/events.js";

function authorizedEvent(transferId: string): ServerEvent {
	return { type: "authorized", transferId, model: "m", estimatedCost: 1, at: "t" };
}

describe("EventBus", () => {
	it("delivers events only to the tenant's subscribers", () => {
		const bus = new EventBus();
		const seenA: ServerEvent[] = [];
		const seenB: ServerEvent[] = [];
		bus.subscribe("a", (e) => seenA.push(e));
		bus.subscribe("b", (e) => seenB.push(e));
		bus.publish("a", authorizedEvent("tx_1"));
		expect(seenA).toHaveLength(1);
		expect(seenB).toHaveLength(0);
	});

	it("unsubscribe stops delivery", () => {
		const bus = new EventBus();
		const seen: ServerEvent[] = [];
		const unsubscribe = bus.subscribe("a", (e) => seen.push(e));
		unsubscribe();
		bus.publish("a", authorizedEvent("tx_2"));
		expect(seen).toHaveLength(0);
	});

	it("unsubscribing one listener leaves the tenant's other listeners intact", () => {
		const bus = new EventBus();
		const seenA: ServerEvent[] = [];
		const seenB: ServerEvent[] = [];
		const unsubscribeA = bus.subscribe("a", (e) => seenA.push(e));
		bus.subscribe("a", (e) => seenB.push(e));
		unsubscribeA();
		bus.publish("a", authorizedEvent("tx_keep"));
		expect(seenA).toHaveLength(0);
		expect(seenB).toHaveLength(1);
	});

	it("a throwing subscriber does not break other subscribers", () => {
		const bus = new EventBus();
		const seen: ServerEvent[] = [];
		bus.subscribe("a", () => {
			throw new Error("boom");
		});
		bus.subscribe("a", (e) => seen.push(e));
		expect(() => bus.publish("a", authorizedEvent("tx_3"))).not.toThrow();
		expect(seen).toHaveLength(1);
	});
});
