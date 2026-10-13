import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
		const { holdFilePath, listPending, recordPending } = await import("../hooks/lib.mjs");
		const sessionId = "sess/../../evil";
		const hostile = holdFilePath(sessionId, "ag/../1", {
			toolUseId: "tu/../1",
			transferId: "tx_1",
		});
		expect(hostile).not.toContain("..");
		expect(hostile.slice(stateDir.length + 1)).not.toContain("/");
		// The transferId is never sanitized: one that is not a valid id names no file.
		for (const transferId of ["tx/../1", "a.b", "", "x".repeat(129)]) {
			expect(() => holdFilePath(sessionId, "main", { toolUseId: "tu_1", transferId })).toThrow(
				"not a valid id",
			);
		}
		const path = await recordPending(sessionId, "main", { toolUseId: "tu_1", transferId: "tx_1" });
		// One file per hold: named by its call AND its transfer.
		expect(path).toBe(join(stateDir, "sess_______evil__main__tu_1.tx_1.json"));
		// The user's alone, as every file in the state dir is: no group or other bits.
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		await recordPending("other-session", "main", { toolUseId: "tu_x", transferId: "tx_x" });
		const entries = await listPending(sessionId, "main");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.toolUseId).toBe("tu_1");
		expect(entries[0]?.transferId).toBe("tx_1");
		expect(entries[0]?.entryKey).toBe("tu_1");
		expect(entries[0]?.agentId).toBe("main");
		expect(entries[0]?.path).toBe(path);
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
		// A stale or concurrent-tool id must not settle someone else's reservation.
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

	it("clearPending removes exactly the hold its listing found, and is idempotent", async () => {
		const { clearPending, listPending, recordPending, takePendingEntry } = await import(
			"../hooks/lib.mjs"
		);
		await recordPending("s", "main", { toolUseId: "a", transferId: "tx_a" });
		await recordPending("s", "main", { toolUseId: "b", transferId: "tx_b" });
		const entry = await takePendingEntry("s", "main", "a");
		expect(entry?.entryKey).toBe("a");
		await clearPending(entry?.path ?? "");
		const rest = await listPending("s", "main");
		expect(rest).toHaveLength(1);
		expect(rest[0]?.transferId).toBe("tx_b");
		await expect(clearPending(entry?.path ?? "")).resolves.toBeUndefined();
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

describe("SessionEnd's budget (Claude Code's, not hooks.json's)", () => {
	it("is 1.5 s by default, CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS when set, never over 10 s — less node's start-up", async () => {
		// @ts-expect-error TS7016: lib.mjs has no type declarations, as for every import here (baselined).
		const { HOOK_BUDGET_MS, sessionEndBudgetMs } = await import("../hooks/lib.mjs");
		const budget = (value?: string) =>
			sessionEndBudgetMs(
				value === undefined ? {} : { CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS: value },
			);
		expect(budget()).toBe(1_200);
		expect(budget("5000")).toBe(4_700);
		// No more than any other hook's budget, whatever the variable says.
		expect(budget("60000")).toBe(HOOK_BUDGET_MS - 300);
		// Not a whole number of milliseconds: the default.
		for (const odd of ["", "abc", "-5", "1.5", "2e3", " 5000"]) expect(budget(odd)).toBe(1_200);
		expect(budget("0")).toBe(0);
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

describe("writes that cannot be confirmed never read as done", () => {
	// lib.mjs by URL, typed by what these rows call: the hooks are plain .mjs.
	const LIB = pathToFileURL(join(import.meta.dirname, "..", "hooks", "lib.mjs")).href;
	const lib = async () =>
		(await import(LIB)) as {
			quarantineHold(path: string): Promise<"ungated" | "removed" | "failed">;
			recordWatchEvent(event: Record<string, unknown>): Promise<boolean>;
		};

	it.skipIf(process.getuid?.() === 0)(
		"quarantineHold rewrites a hold IN PLACE: it works in a directory where no temp file or rename can be made",
		async () => {
			const { quarantineHold } = await lib();
			const dir = join(stateDir, "holds");
			await mkdir(dir);
			const hold = join(dir, "s__main__tu_1.tx_1.json");
			await writeFile(hold, JSON.stringify({ transferId: "tx_1", toolUseId: "tu_1", gate: 1 }), {
				mode: 0o600,
			});
			// Quarantine runs when a rename in this directory has failed: no new entry can be made.
			await chmod(dir, 0o500);
			try {
				// mutant: a temp file plus rename (writeFileAtomic) -> EACCES -> "removed" or "failed"
				expect(await quarantineHold(hold)).toBe("ungated");
			} finally {
				await chmod(dir, 0o700);
			}
			expect(JSON.parse(await readFile(hold, "utf-8"))).toEqual({
				transferId: "tx_1",
				toolUseId: "tu_1",
				ran: true,
			});
			expect(await readdir(dir)).toEqual(["s__main__tu_1.tx_1.json"]);
		},
	);

	it("quarantineHold never writes through a FIFO in a hold's place: it is removed, at once", async () => {
		if (process.platform === "win32") return;
		const { quarantineHold } = await lib();
		const fifo = join(stateDir, "s__main__tu_2.tx_2.json");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const started = Date.now();
		expect(await quarantineHold(fifo)).toBe("removed");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it("a close that fails (EIO) after the append is a record NOT written, and the hook says so", async () => {
		// A FileHandle's close is its own property, so the failure is injected where lib.mjs
		// opens: every handle it opens has a close that closes, then reports the late EIO a full
		// or failing disk gives.
		// The path of every handle whose close failed.
		const failures: string[] = [];
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const real = await importOriginal<typeof import("node:fs/promises")>();
			return {
				...real,
				open: async (...args: Parameters<typeof real.open>) => {
					const handle = await real.open(...args);
					const close = handle.close.bind(handle);
					handle.close = async () => {
						await close();
						failures.push(String(args[0]));
						throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
					};
					return handle;
				},
			};
		});
		vi.resetModules();
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		let said = "";
		try {
			const { recordWatchEvent } = await lib();
			// mutant: close().catch(() => {}) -> true, no warning
			expect(await recordWatchEvent({ kind: "gap", session: "s", started: null })).toBe(false);
			said = stderr.mock.calls.map((c) => String(c[0])).join("");
		} finally {
			stderr.mockRestore();
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
		// The watch log's append failed once. The session's stamp is made all the same (the hook
		// ran): it is published, then read back, and its read's late close is the other failure here.
		expect(failures.filter((path) => path.endsWith("watch.jsonl"))).toHaveLength(1);
		expect(failures.some((path) => path.endsWith(join("since-session", "s")))).toBe(true);
		expect(said).toContain("could not write a watch record");
		expect(said).toContain("EIO");
	});
});
