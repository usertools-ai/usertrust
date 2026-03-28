/**
 * Circuit Breaker tests
 *
 * Tests the full state machine: closed → open → half-open → closed,
 * per-key isolation via the registry, and snapshot diagnostics.
 */

import { describe, expect, it } from "vitest";
import {
	CircuitBreaker,
	CircuitBreakerRegistry,
	CircuitOpenError,
} from "../../src/resilience/circuit.js";

// ---------------------------------------------------------------------------
// CircuitBreaker — state machine
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
	it("starts in closed state", () => {
		const cb = new CircuitBreaker("test");
		expect(cb.getState()).toBe("closed");
	});

	it("allows requests when closed", () => {
		const cb = new CircuitBreaker("test");
		expect(() => cb.allowRequest()).not.toThrow();
	});

	it("opens after reaching failure threshold", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 3 });
		cb.recordFailure();
		cb.recordFailure();
		expect(cb.getState()).toBe("closed");
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
	});

	it("rejects requests when open", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 1 });
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
		expect(() => cb.allowRequest()).toThrow(CircuitOpenError);
	});

	it("transitions to half-open after reset timeout", () => {
		let now = 1000;
		const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 500 }, () => now);
		cb.recordFailure();
		expect(cb.getState()).toBe("open");

		now = 1499;
		expect(cb.getState()).toBe("open");

		now = 1500;
		expect(cb.getState()).toBe("half-open");
	});

	it("allows requests when half-open", () => {
		let now = 1000;
		const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 100 }, () => now);
		cb.recordFailure();
		now = 1100;
		expect(cb.getState()).toBe("half-open");
		expect(() => cb.allowRequest()).not.toThrow();
	});

	it("closes after enough successes in half-open", () => {
		let now = 1000;
		const cb = new CircuitBreaker(
			"test",
			{
				failureThreshold: 1,
				resetTimeoutMs: 100,
				halfOpenSuccessThreshold: 2,
			},
			() => now,
		);
		cb.recordFailure();
		now = 1100;
		expect(cb.getState()).toBe("half-open");

		cb.recordSuccess();
		expect(cb.getState()).toBe("half-open");
		cb.recordSuccess();
		expect(cb.getState()).toBe("closed");
	});

	it("reopens on failure in half-open", () => {
		let now = 1000;
		const cb = new CircuitBreaker("test", { failureThreshold: 1, resetTimeoutMs: 100 }, () => now);
		cb.recordFailure();
		now = 1100;
		expect(cb.getState()).toBe("half-open");

		cb.recordFailure();
		expect(cb.getState()).toBe("open");
	});

	it("resets failure count on success in closed state", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 3 });
		cb.recordFailure();
		cb.recordFailure();
		cb.recordSuccess(); // resets count
		cb.recordFailure();
		cb.recordFailure();
		// Only 2 failures since reset, not 3
		expect(cb.getState()).toBe("closed");
	});

	it("force-reset returns to closed", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 1 });
		cb.recordFailure();
		expect(cb.getState()).toBe("open");
		cb.reset();
		expect(cb.getState()).toBe("closed");
	});

	it("snapshot returns current state", () => {
		const cb = new CircuitBreaker("test", { failureThreshold: 3 });
		cb.recordFailure();
		cb.recordFailure();

		const snap = cb.snapshot();
		expect(snap.state).toBe("closed");
		expect(snap.consecutiveFailures).toBe(2);
		expect(snap.lastFailureTime).not.toBeNull();
	});

	it("CircuitOpenError contains breaker key", () => {
		const err = new CircuitOpenError("http_request");
		expect(err.breakerKey).toBe("http_request");
		expect(err.message).toContain("http_request");
		expect(err.name).toBe("CircuitOpenError");
	});
});

// ---------------------------------------------------------------------------
// CircuitBreakerRegistry — per-key isolation
// ---------------------------------------------------------------------------

describe("CircuitBreakerRegistry", () => {
	it("creates breakers on first access", () => {
		const reg = new CircuitBreakerRegistry();
		const b1 = reg.get("http_request");
		expect(b1.getState()).toBe("closed");
		expect(reg.size).toBe(1);
	});

	it("returns the same breaker for the same key", () => {
		const reg = new CircuitBreakerRegistry();
		const b1 = reg.get("http_request");
		const b2 = reg.get("http_request");
		expect(b1).toBe(b2);
	});

	it("creates separate breakers for different keys", () => {
		const reg = new CircuitBreakerRegistry();
		const b1 = reg.get("http_request");
		const b2 = reg.get("llm_infer");
		expect(b1).not.toBe(b2);
		expect(reg.size).toBe(2);
	});

	it("per-key isolation — one key's failures don't affect another", () => {
		const reg = new CircuitBreakerRegistry({ failureThreshold: 2 });
		const a = reg.get("provider-a");
		const b = reg.get("provider-b");

		a.recordFailure();
		a.recordFailure();
		expect(a.getState()).toBe("open");
		expect(b.getState()).toBe("closed");
	});

	it("allSnapshots returns state for all breakers", () => {
		const reg = new CircuitBreakerRegistry({ failureThreshold: 1 });
		const b = reg.get("test");
		b.recordFailure();

		const snaps = reg.allSnapshots();
		expect(snaps.test?.state).toBe("open");
	});

	it("resetAll closes all breakers", () => {
		const reg = new CircuitBreakerRegistry({ failureThreshold: 1 });
		reg.get("a").recordFailure();
		reg.get("b").recordFailure();

		reg.resetAll();
		expect(reg.get("a").getState()).toBe("closed");
		expect(reg.get("b").getState()).toBe("closed");
	});

	it("passes config to new breakers", () => {
		const reg = new CircuitBreakerRegistry({ failureThreshold: 2 });
		const b = reg.get("test");
		b.recordFailure();
		expect(b.getState()).toBe("closed");
		b.recordFailure();
		expect(b.getState()).toBe("open");
	});
});
