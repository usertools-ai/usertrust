// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A vault that kept changing while the verifier read it has no verdict (`busy`), and a vault whose
 * chain could not be read at all is a failure: neither is "BROKEN" by tampering, nor "not found". The
 * UI says so in its summary and on its verify endpoint. The verifiers' own detection of either is
 * tested in their packages; here they are stood in for.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stand = vi.hoisted(() => ({
	vault: undefined as "busy" | undefined,
	tx: undefined as "busy" | "failed" | undefined,
	/** The snapshot-read bounds each dashboard load passed to the verifier. */
	reads: [] as unknown[],
}));

vi.mock("usertrust", async (importOriginal) => {
	const orig = await importOriginal<typeof import("usertrust")>();
	return {
		...orig,
		verifyVaultBounded: (vaultPath: string, opts: Parameters<typeof orig.verifyVaultBounded>[1]) =>
			stand.reads.push(opts) > 0 && stand.vault === "busy"
				? {
						valid: false,
						errors: ["the vault is being written: no verdict (run verify again)"],
						chainLength: 0,
						validHashes: 0,
						merkleRoot: null,
						firstEvent: null,
						lastEvent: null,
						tailState: null,
						busy: true as const,
					}
				: orig.verifyVaultBounded(vaultPath, opts),
	};
});
vi.mock("usertrust-verify", async (importOriginal) => {
	const orig = await importOriginal<typeof import("usertrust-verify")>();
	return {
		...orig,
		verifyTransaction: (...a: Parameters<typeof orig.verifyTransaction>) =>
			stand.tx === undefined
				? orig.verifyTransaction(...a)
				: {
						found: false,
						valid: false,
						receipt: "",
						errors: ["stood in"],
						...(stand.tx === "busy" ? { busy: true as const } : { failed: true as const }),
					},
	};
});

const { loadState } = await import("../src/server/state.js");
const { createAuditWriter } = await import("../../core/src/audit/chain.js");
const { createUiServer } = await import("../src/server/server.js");
const { __tailTestSeam } = await import("../src/server/tail.js");
const { chainStatus } = await import("../src/shared/display.js");
const { verifyOutcome } = await import("../src/shared/verify-view.js");

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-ui-busy-"));
	mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	stand.vault = undefined;
	stand.tx = undefined;
	stand.reads = [];
});
afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("the UI on a vault with no verdict", () => {
	it("the summary says busy, never only 'not valid'", () => {
		stand.vault = "busy";
		const state = loadState(join(tempDir, ".usertrust"));
		expect(state.summary.chain).toMatchObject({ valid: false, busy: true });
	});

	it("a load reads the vault with a bounded snapshot read: 3 attempts at most, 10 ms apart, never the verifier's 26 at 100 ms", () => {
		loadState(join(tempDir, ".usertrust"));
		expect(stand.reads.length).toBeGreaterThan(0);
		for (const opts of stand.reads) expect(opts).toEqual({ attempts: 3, delayMs: 10 });
	});

	it("CONTROL: a vault at rest has no busy flag", () => {
		const state = loadState(join(tempDir, ".usertrust"));
		expect(state.summary.chain.busy).toBeUndefined();
		expect(state.summary.chain.valid).toBe(true);
	});

	it("the verify endpoint answers a busy vault 503 and an unreadable one 500, never 404", async () => {
		const ui = await createUiServer(tempDir, { port: 0 });
		try {
			stand.tx = "busy";
			expect((await fetch(`http://127.0.0.1:${ui.port}/api/verify/tx_1`)).status).toBe(503);
			stand.tx = "failed";
			expect((await fetch(`http://127.0.0.1:${ui.port}/api/verify/tx_1`)).status).toBe(500);
			stand.tx = undefined;
			expect((await fetch(`http://127.0.0.1:${ui.port}/api/verify/tx_1`)).status).toBe(404);
		} finally {
			await ui.close();
		}
	});
});

describe("the dashboard's words for a vault with no verdict", () => {
	const chain = { events: 0, valid: false, empty: false, breakIndex: null, errors: ["e"] };

	it("the summary's status is busy, never broken", () => {
		expect(chainStatus({ ...chain, busy: true })).toBe("busy");
	});

	it("CONTROL: the same chain without busy is broken", () => {
		expect(chainStatus(chain)).toBe("broken");
	});

	it("a verify answer of busy is no verdict, and a failed read is a failure: neither is 'not found'", () => {
		const body = { found: false, valid: false, receipt: "", errors: ["why"] };
		expect(verifyOutcome(503, { ...body, busy: true })).toEqual({ kind: "busy", reason: "why" });
		expect(verifyOutcome(500, { ...body, failed: true })).toEqual({
			kind: "failed",
			receipt: "",
			reason: "why",
		});
	});

	it("CONTROL: the same answer without either flag is 'not found'", () => {
		const body = { found: false, valid: false, receipt: "", errors: ["why"] };
		expect(verifyOutcome(404, body)).toEqual({ kind: "not-found", receipt: "", reason: "why" });
	});
});

// Each row polls for at most 3 s, well inside its own 15 s limit: a verdict that never clears fails the
// row's assertion, never its timeout.
describe("a busy verdict on the live dashboard clears once the vault holds still", {
	timeout: 15_000,
}, () => {
	/** One event on the chain, so a load sees log bytes and only the verdict can send a grow to a full reload. */
	async function oneEvent(n: number): Promise<void> {
		const w = createAuditWriter(tempDir);
		try {
			await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: `tx_${n}` } });
		} finally {
			w.release();
		}
	}

	/** The summary's chain, polled until `done` holds or `ms` pass: the last one read. */
	async function chainUntil(
		port: number,
		done: (chain: Record<string, unknown>) => boolean,
		ms: number,
	): Promise<Record<string, unknown>> {
		const deadline = Date.now() + ms;
		for (;;) {
			const body = (await (await fetch(`http://127.0.0.1:${port}/api/summary`)).json()) as {
				chain: Record<string, unknown>;
			};
			if (done(body.chain) || Date.now() > deadline) return body.chain;
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	/** The watcher's intervals, shortened for one row (read when the watcher starts), and put back after it. */
	async function withTail(
		intervals: Partial<Pick<typeof __tailTestSeam, "backstopMs" | "failedReadRetryMs">>,
		run: () => Promise<void>,
	): Promise<void> {
		const saved = { ...__tailTestSeam };
		Object.assign(__tailTestSeam, intervals);
		try {
			await run();
		} finally {
			Object.assign(__tailTestSeam, saved);
		}
	}

	it("with no append at all: a busy load is a failed read, retried until a load gives a verdict", async () => {
		await oneEvent(1);
		stand.vault = "busy";
		await withTail({ backstopMs: 50, failedReadRetryMs: 200 }, async () => {
			const ui = await createUiServer(tempDir, { port: 0 });
			try {
				expect((await chainUntil(ui.port, () => true, 0)).busy).toBe(true);
				// The writer stops: nothing changes on disk from here on.
				stand.vault = undefined;
				const chain = await chainUntil(ui.port, (c) => c.busy !== true, 3_000);
				expect(chain).toMatchObject({ valid: true, events: 1 });
				expect(chain.busy).toBeUndefined();
			} finally {
				await ui.close();
			}
		});
	});

	it("an append while busy is a full reload, which gives the verdict (the failed-read retry too far off to)", async () => {
		await oneEvent(1);
		stand.vault = "busy";
		await withTail({ failedReadRetryMs: 600_000 }, async () => {
			const ui = await createUiServer(tempDir, { port: 0 });
			try {
				expect((await chainUntil(ui.port, () => true, 0)).busy).toBe(true);
				stand.vault = undefined;
				await oneEvent(2);
				const chain = await chainUntil(ui.port, (c) => c.busy !== true, 3_000);
				expect(chain).toMatchObject({ valid: true, events: 2 });
				expect(chain.busy).toBeUndefined();
			} finally {
				await ui.close();
			}
		});
	});
});
