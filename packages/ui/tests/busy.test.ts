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
}));

vi.mock("usertrust", async (importOriginal) => {
	const orig = await importOriginal<typeof import("usertrust")>();
	return {
		...orig,
		verifyVault: (vaultPath: string) =>
			stand.vault === "busy"
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
				: orig.verifyVault(vaultPath),
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
const { createUiServer } = await import("../src/server/server.js");
const { chainStatus } = await import("../src/shared/display.js");
const { verifyOutcome } = await import("../src/shared/verify-view.js");

let tempDir: string;
beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "trust-ui-busy-"));
	mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	stand.vault = undefined;
	stand.tx = undefined;
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
