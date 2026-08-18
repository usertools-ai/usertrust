/**
 * run.test.mts — the exit-code contract (spec §6).
 *
 * The claim this whole tool rests on is that "could not check" and "checked,
 * found nothing" are DIFFERENT STATES. These tests are the only thing standing
 * between that claim and a source outage silently scoring as a pass.
 *
 * `fetch` is stubbed rather than the network being blocked at the OS level:
 * Node's fetch ignores `https_proxy`, so a proxy-based probe succeeds normally
 * and proves nothing. (Confirmed the hard way, 2026-08-18.)
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const realFetch = globalThis.fetch;

async function runMain(stub: typeof globalThis.fetch): Promise<number> {
	globalThis.fetch = stub;
	// Import fresh each time so the module picks up the current stub.
	const { main } = await import("./run.mts");
	return main([]);
}

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("exit-code contract", () => {
	it("returns 2 when a source is unreachable — never 0", async () => {
		const code = await runMain((async () => {
			throw new Error("ENETDOWN (simulated)");
		}) as typeof globalThis.fetch);

		assert.equal(code, 2, "a dead network must not score as a clean table");
		assert.notEqual(code, 0);
	});

	it("returns 2 on an HTTP error response", async () => {
		const code = await runMain(
			(async () =>
				new Response("nope", {
					status: 500,
					statusText: "Server Error",
				})) as typeof globalThis.fetch,
		);

		assert.equal(code, 2);
	});

	it("returns 2 when a source returns valid JSON of the wrong shape", async () => {
		// A schema change is "could not check", not "checked and found nothing".
		const code = await runMain(
			(async () =>
				new Response('"a bare string"', {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as typeof globalThis.fetch,
		);

		assert.equal(code, 2);
	});
});
