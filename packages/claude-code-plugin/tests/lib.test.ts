import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// lib.mjs reads env at call time; set the state dir before importing.
let stateDir: string;
beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-"));
	process.env.UT_CC_STATE_DIR = stateDir;
});
afterEach(() => {
	// biome-ignore lint/performance/noDelete: must remove env var, not set to "undefined" string
	delete process.env.UT_CC_STATE_DIR;
	vi.unstubAllGlobals();
});

describe("pending state store (one file per hold)", () => {
	it("records one file per hold, scoped per session+agent, with sanitized path components", async () => {
		const { listPending, recordPending, stateFilePath } = await import("../hooks/lib.mjs");
		const sessionId = "sess/../../evil";
		expect(stateFilePath(sessionId, "ag/../1", "tu/../1")).not.toContain("..");
		await recordPending(sessionId, "main", { toolUseId: "tu_1", transferId: "tx_1" });
		await recordPending("other-session", "main", { toolUseId: "tu_x", transferId: "tx_x" });
		const entries = await listPending(sessionId, "main");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.toolUseId).toBe("tu_1");
		expect(entries[0]?.transferId).toBe("tx_1");
		expect(entries[0]?.entryKey).toBe("tu_1");
		expect(entries[0]?.agentId).toBe("main");
	});

	it("scopes holds per agent: a specific agent sees only its own; null sees all", async () => {
		const { listPending, recordPending } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", { toolUseId: "tu_main", transferId: "tx_main" });
		await recordPending("s", "agent-A", { toolUseId: "tu_a", transferId: "tx_a" });
		await recordPending("s", "agent-B", { toolUseId: "tu_b", transferId: "tx_b" });
		expect((await listPending("s", "agent-A")).map((e) => e.transferId)).toEqual(["tx_a"]);
		expect((await listPending("s", "main")).map((e) => e.transferId)).toEqual(["tx_main"]);
		expect((await listPending("s", null)).map((e) => e.transferId).sort()).toEqual([
			"tx_a",
			"tx_b",
			"tx_main",
		]);
		// Every entry carries its owning agent so a whole-session sweep can clear it.
		const all = await listPending("s", null);
		expect(all.find((e) => e.transferId === "tx_a")?.agentId).toBe("agent-A");
		expect(all.find((e) => e.transferId === "tx_main")?.agentId).toBe("main");
	});

	it("concurrent hooks are safe by construction: parallel records never clobber", async () => {
		const { listPending, recordPending } = await import("../hooks/lib.mjs");
		await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				recordPending("s", "main", { toolUseId: `tu_${i}`, transferId: `tx_${i}` }),
			),
		);
		const entries = await listPending("s", "main");
		expect(entries.map((e) => e.transferId).sort()).toEqual([
			"tx_0",
			"tx_1",
			"tx_2",
			"tx_3",
			"tx_4",
		]);
	});

	it("takePendingEntry matches by toolUseId within the agent and never deletes", async () => {
		const { listPending, recordPending, takePendingEntry } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", { toolUseId: "a", transferId: "tx_a" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await recordPending("s", "main", { toolUseId: "b", transferId: "tx_b" });
		expect((await takePendingEntry("s", "main", "b"))?.transferId).toBe("tx_b");
		// Deletion happens only after a successful settle (clearPending), never on take.
		expect(await listPending("s", "main")).toHaveLength(2);
		expect(await takePendingEntry("empty-session", "main", null)).toBeNull();
	});

	it("unmatched non-empty toolUseId returns null and does not steal the oldest hold", async () => {
		const { recordPending, takePendingEntry } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", { toolUseId: "a", transferId: "tx_a" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await recordPending("s", "main", { toolUseId: "b", transferId: "tx_b" });
		// A stale or concurrent-tool id must not settle someone else's reservation (AUD-005).
		expect(await takePendingEntry("s", "main", "zzz")).toBeNull();
	});

	it("missing or empty toolUseId still returns the oldest entry", async () => {
		const { recordPending, takePendingEntry } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", { toolUseId: "a", transferId: "tx_a" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		await recordPending("s", "main", { toolUseId: "b", transferId: "tx_b" });
		// Hosts that never send tool_use_id keep the oldest-entry fallback.
		expect((await takePendingEntry("s", "main", null))?.transferId).toBe("tx_a");
		expect((await takePendingEntry("s", "main", undefined))?.transferId).toBe("tx_a");
		expect((await takePendingEntry("s", "main", ""))?.transferId).toBe("tx_a");
	});

	it("persists the authorize-time input estimate so settle can price both legs", async () => {
		const { listPending, recordPending, takePendingEntry } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", {
			toolUseId: "a",
			transferId: "tx_a",
			estimatedInputTokens: 12,
		});
		expect((await listPending("s", "main"))[0]?.estimatedInputTokens).toBe(12);
		expect((await takePendingEntry("s", "main", "a"))?.estimatedInputTokens).toBe(12);
	});

	it("takePendingEntry never crosses agents: an agent's toolUseId cannot match a sibling's hold", async () => {
		const { recordPending, takePendingEntry } = await import("../hooks/lib.mjs");
		await recordPending("s", "agent-A", { toolUseId: "shared", transferId: "tx_a" });
		await recordPending("s", "agent-B", { toolUseId: "shared", transferId: "tx_b" });
		expect((await takePendingEntry("s", "agent-A", "shared"))?.transferId).toBe("tx_a");
		expect((await takePendingEntry("s", "agent-B", "shared"))?.transferId).toBe("tx_b");
		// A third agent with no holds gets nothing, even though "shared" exists elsewhere.
		expect(await takePendingEntry("s", "agent-C", "shared")).toBeNull();
	});

	it("clearPending removes exactly the named hold for that agent and is idempotent", async () => {
		const { clearPending, listPending, recordPending, takePendingEntry } = await import(
			"../hooks/lib.mjs"
		);
		await recordPending("s", "main", { toolUseId: "a", transferId: "tx_a" });
		await recordPending("s", "main", { toolUseId: "b", transferId: "tx_b" });
		const entry = await takePendingEntry("s", "main", "a");
		expect(entry?.entryKey).toBe("a");
		await clearPending("s", "main", entry?.entryKey ?? "");
		const rest = await listPending("s", "main");
		expect(rest).toHaveLength(1);
		expect(rest[0]?.transferId).toBe("tx_b");
		await expect(clearPending("s", "main", "a")).resolves.toBeUndefined();
	});

	it("keys entries without a toolUseId by transferId and skips corrupt files", async () => {
		const { listPending, recordPending } = await import("../hooks/lib.mjs");
		await recordPending("s", "main", { toolUseId: null, transferId: "tx_solo" });
		await writeFile(join(stateDir, "s__main__junk.json"), "{not json");
		await writeFile(join(stateDir, "s__main__notx.json"), JSON.stringify({ toolUseId: "t" }));
		const entries = await listPending("s", "main");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.entryKey).toBe("tx_solo");
		expect(entries[0]?.toolUseId).toBeNull();
	});
});

describe("estimateTokens", () => {
	it("is ceil(len/4) with a floor of 1", async () => {
		const { estimateTokens } = await import("../hooks/lib.mjs");
		expect(estimateTokens("")).toBe(1);
		expect(estimateTokens("abcdefgh")).toBe(2);
	});

	it("sizes the 16 KiB output hold via the same estimator as input", async () => {
		const { MAX_CONTENT_CHARS, MAX_OUTPUT_TOKENS, estimateTokens } = await import(
			"../hooks/lib.mjs"
		);
		expect(MAX_CONTENT_CHARS).toBe(16 * 1024);
		expect(MAX_OUTPUT_TOKENS).toBe(estimateTokens("x".repeat(MAX_CONTENT_CHARS)));
		expect(MAX_OUTPUT_TOKENS).toBe(4096);
	});
});

describe("serverRequest", () => {
	it("sends bearer auth and returns status + json", async () => {
		const { serverRequest } = await import("../hooks/lib.mjs");
		const fetchMock = vi.fn(async (_url: unknown, init: { headers: Record<string, string> }) => {
			expect(init.headers.authorization).toBe("Bearer k123");
			return new Response(JSON.stringify({ transferId: "tx_9" }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		process.env.UT_SERVER_KEY = "k123";
		const result = await serverRequest("/v1/authorize", { model: "m" });
		expect(result.status).toBe(200);
		expect((result.json as { transferId: string }).transferId).toBe("tx_9");
		// biome-ignore lint/performance/noDelete: must remove env var, not set to "undefined" string
		delete process.env.UT_SERVER_KEY;
	});

	it("wraps network failure in TransportError", async () => {
		const { serverRequest, TransportError } = await import("../hooks/lib.mjs");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		await expect(serverRequest("/v1/authorize", {})).rejects.toThrow(TransportError);
	});
});
