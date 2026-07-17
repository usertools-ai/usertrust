import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { type UsertrustServer, createUsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY_A = "ut_sse_tenant_a";
const KEY_B = "ut_sse_tenant_b";

function config(): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-sse-cap",
		enforcement: "enforce",
		pendingTtlMs: 50,
		dryRun: true,
		tenants: [
			{ id: "acme", keyHash: hashKey(KEY_A) },
			{ id: "beta", keyHash: hashKey(KEY_B) },
		],
	};
}

let server: UsertrustServer | undefined;
const controllers: AbortController[] = [];

/** Open an SSE stream and keep it open (its body is never drained). */
function openSse(base: string, key: string): Promise<Response> {
	const controller = new AbortController();
	controllers.push(controller);
	return fetch(`${base}/v1/events`, {
		headers: { authorization: `Bearer ${key}` },
		signal: controller.signal,
	});
}

afterEach(async () => {
	for (const c of controllers) c.abort();
	controllers.length = 0;
	await server?.close();
	server = undefined;
});

describe("per-tenant SSE connection cap", () => {
	it("caps a tenant at 8 concurrent streams (429) while a second tenant can still connect", async () => {
		const fake = createFakeGovernor();
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const open = await Promise.all(Array.from({ length: 8 }, () => openSse(base, KEY_A)));
		for (const res of open) {
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");
		}

		// The 9th concurrent stream for the same tenant is rejected.
		const ninth = await openSse(base, KEY_A);
		expect(ninth.status).toBe(429);
		const body = (await ninth.json()) as { error: string; reason: string };
		expect(body.error).toBe("too_many_streams");
		expect(body.reason).toContain("SSE subscriber limit");

		// The cap is per tenant: a different tenant is unaffected.
		const other = await openSse(base, KEY_B);
		expect(other.status).toBe(200);
		expect(other.headers.get("content-type")).toContain("text/event-stream");
	});

	it("frees a tenant's slot when a subscriber disconnects", async () => {
		const fake = createFakeGovernor();
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;

		const open = await Promise.all(Array.from({ length: 8 }, () => openSse(base, KEY_A)));
		expect(open.every((r) => r.status === 200)).toBe(true);
		expect((await openSse(base, KEY_A)).status).toBe(429);

		// Drop one subscriber; the server observes the close and frees its slot.
		controllers[0]?.abort();
		let reconnected: Response | undefined;
		for (let attempt = 0; attempt < 50; attempt += 1) {
			const res = await openSse(base, KEY_A);
			if (res.status === 200) {
				reconnected = res;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(reconnected?.status).toBe(200);
	});
});
