import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_sse_key";

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir: "/tmp/utsrv-sse",
		enforcement: "enforce",
		pendingTtlMs: 50,
		dryRun: true,
		tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
		...overrides,
	};
}

let server: UsertrustServer | undefined;
afterEach(async () => {
	await server?.close();
	server = undefined;
});

describe("SSE + shadow + sweep", () => {
	it("streams authorized/settled events over SSE", async () => {
		const fake = createFakeGovernor();
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		const controller = new AbortController();
		const sse = await fetch(`${base}/v1/events`, {
			headers: { authorization: `Bearer ${KEY}` },
			signal: controller.signal,
		});
		expect(sse.headers.get("content-type")).toContain("text/event-stream");
		expect(sse.body).not.toBeNull();
		// biome-ignore lint/style/noNonNullAssertion: guarded by expect above
		const reader = sse.body!.getReader();
		const auth = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 }),
		});
		expect(auth.status).toBe(200);
		let buffer = "";
		while (!buffer.includes("event: authorized")) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += new TextDecoder().decode(value);
		}
		expect(buffer).toContain("event: authorized");
		expect(buffer).toContain('"model":"m"');
		controller.abort();
	});

	it("evaluate_only mode converts denials to shadow allows and emits shadow denied events", async () => {
		const fake = createFakeGovernor({ denyReason: "rule says no" });
		server = createUsertrustServer({
			config: config({ enforcement: "evaluate_only" }),
			factory: async () => fake.governor,
		});
		const { port } = await server.listen();
		const seen: unknown[] = [];
		server.bus.subscribe("acme", (e) => seen.push(e));
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "m" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			shadow: boolean;
			decision: string;
			shadowId: string;
			transferId?: string;
		};
		expect(body.shadow).toBe(true);
		expect(body.decision).toBe("would_deny");
		// Shadow responses carry a shadowId, never a transferId — there is no
		// reservation to settle or abort, so those routes 404 on shadow ids.
		expect(body.shadowId).toMatch(/^shadow_/);
		expect(body.transferId).toBeUndefined();
		const settle = await fetch(`http://127.0.0.1:${port}/v1/settle`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ transferId: body.shadowId }),
		});
		expect(settle.status).toBe(404);
		expect(
			seen.some(
				(e) =>
					(e as { type: string; shadow: boolean }).type === "denied" &&
					(e as { shadow: boolean }).shadow === true,
			),
		).toBe(true);
	});

	it("evaluate_only still runs the real governor, so its denial event exists", async () => {
		// The server converts the error AFTER `governor.authorize()` has already
		// returned its decision, so the chain event is written by the governor
		// and the shadowing is presentation only. There is deliberately no
		// suppression API: an operator running in shadow mode is exactly the
		// operator who needs the denial record.
		const fake = createFakeGovernor({ denyReason: "rule says no" });
		let authorizeCalls = 0;
		const spying = {
			...fake.governor,
			authorize: async (params: Parameters<typeof fake.governor.authorize>[0]) => {
				authorizeCalls++;
				return fake.governor.authorize(params);
			},
		};
		server = createUsertrustServer({
			config: config({ enforcement: "evaluate_only" }),
			factory: async () => spying,
		});
		const { port } = await server.listen();
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "m" }),
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { decision: string }).decision).toBe("would_deny");
		expect(authorizeCalls).toBe(1);
	});

	it("sweepExpired aborts stale pending holds", async () => {
		const fake = createFakeGovernor();
		server = createUsertrustServer({ config: config(), factory: async () => fake.governor });
		const { port } = await server.listen();
		await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
			body: JSON.stringify({ model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 }),
		});
		expect(server.pendingCount()).toBe(1);
		const swept = await server.sweepExpired(Date.now() + 60_000);
		expect(swept).toBe(1);
		expect(server.pendingCount()).toBe(0);
		expect(fake.calls.aborted).toHaveLength(1);
	});
});
