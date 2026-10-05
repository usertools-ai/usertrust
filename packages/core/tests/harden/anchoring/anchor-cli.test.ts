// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — anchor CLI regressions: `anchor now --json` and `anchor rotate`
 * must report failure (exit 1) when a record is emitted but never delivered
 * to any sink (spec §5.3); the core `verify` CLI rejects unknown flags so a
 * typo cannot silently weaken a CI gate (spec §7.5).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import { run as verifyRun } from "../../../src/cli/verify.js";
import { appendEvents, cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const origCwd = process.cwd();
const origArgv = process.argv;

afterEach(() => {
	process.chdir(origCwd);
	process.argv = origArgv;
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

function captureLog(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		lines.push(a.map(String).join(" "));
	});
	return { lines, restore: () => spy.mockRestore() };
}

describe("HARDEN: `anchor now --json` is delivery-gated", () => {
	it("reports success:false and exit 1 when every sink fails (record stranded in outbox)", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const unwritable = "/proc/nonexistent/anchors.jsonl"; // guaranteed write failure
		const { lines, restore } = captureLog();
		try {
			await anchorRun(["now", "--sink-file", unwritable, "--publish-retries", "1"], { json: true });
		} finally {
			restore();
		}
		const out = JSON.parse(lines.at(-1) as string);
		expect(out.command).toBe("anchor now");
		expect(out.success).toBe(false);
		expect(out.data.delivered).toBe(false);
		expect(out.data.outboxDepth).toBeGreaterThan(0);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: `anchor rotate` is delivery-gated", () => {
	it("reports success:false and exit 1 when the rotation record never reaches a sink", async () => {
		const s = await makeAnchoredVault(3);
		await appendEvents(s.root, 1, 4);
		process.chdir(s.root);
		process.env.USERTRUST_ANCHOR_KEY = s.keyFile;
		const unwritable = "/proc/nonexistent/anchors.jsonl";
		const { lines, restore } = captureLog();
		try {
			await anchorRun(["rotate", "--sink-file", unwritable, "--publish-retries", "1"], {
				json: true,
			});
		} finally {
			restore();
		}
		const out = JSON.parse(lines.at(-1) as string);
		expect(out.command).toBe("anchor rotate");
		expect(out.success).toBe(false);
		expect(out.data.delivered).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: core `verify` CLI rejects unknown flags", () => {
	it("a typoed --require-anchro fails loudly instead of silently weakening the gate", async () => {
		const root = tmp("verify-flag-");
		await appendEvents(root, 2);
		process.argv = ["node", "usertrust", "verify", "--require-anchro"];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(root, { json: false });
		} finally {
			restore();
		}
		expect(lines.join("\n")).toMatch(/Unknown flag: --require-anchro/);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: the verify CLI makes the ABSENCE of witnessing visible (Codex #128 F6)", () => {
	it("prints a witness line on an anchored vault with no receipts, instead of only VERIFIED", async () => {
		// The human-facing half of G5. The library reported the witness state
		// from the first commit, but neither CLI rendered it — so an operator
		// still read "VERIFIED (externally anchored)" and exit 0 with nothing
		// saying the transparency-log leg had never run. That is the silent
		// success this work exists to remove, surviving in the one place a
		// person actually looks.
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.argv = ["node", "usertrust", "verify", "--anchors", s.storeFile];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(s.root, { json: false });
		} finally {
			restore();
		}
		const out = lines.join("\n");
		expect(out).toMatch(/Witness log: WITNESS_UNKNOWN/);
		expect(out).toMatch(/anchors covered/);
	});

	it("--require-witness exits 1 on that same vault, while the default still exits 0", async () => {
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);

		// Default: unchanged. A vault that verified clean yesterday still does.
		process.argv = ["node", "usertrust", "verify", "--anchors", s.storeFile];
		let cap = captureLog();
		try {
			await verifyRun(s.root, { json: false });
		} finally {
			cap.restore();
		}
		expect(process.exitCode).toBe(0);

		// Opt in, and the same vault is refused.
		process.exitCode = 0;
		process.argv = ["node", "usertrust", "verify", "--anchors", s.storeFile, "--require-witness"];
		cap = captureLog();
		try {
			await verifyRun(s.root, { json: false });
		} finally {
			cap.restore();
		}
		expect(process.exitCode).toBe(1);
	});

	it("--json does not report success:true when the witness gate fails", async () => {
		// A consumer reading the body rather than $? would otherwise be told the
		// run succeeded while the process exited 1.
		const s = await makeAnchoredVault(3);
		process.chdir(s.root);
		process.argv = ["node", "usertrust", "verify", "--anchors", s.storeFile, "--require-witness"];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(s.root, { json: true });
		} finally {
			restore();
		}
		const payload = JSON.parse(lines.join("")) as {
			success: boolean;
			data: { anchoring: unknown };
		};
		expect(payload.success).toBe(false);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: a flag is never consumed as another flag's value (Codex #128-r2 F1)", () => {
	it("--vault-id --require-witness refuses instead of swallowing the gate", async () => {
		// The worst shape available for a CI gate: `--vault-id` ate
		// `--require-witness` as its value, so the run verified UNANCHORED,
		// printed no witness line, and exited 0 — the pipeline stays green while
		// checking nothing. Mirrors requireValue in cli/budget.ts.
		const s = await makeAnchoredVault(2);
		process.chdir(s.root);
		process.argv = ["node", "usertrust", "verify", "--vault-id", "--require-witness"];
		const { lines, restore } = captureLog();
		let threw = "";
		try {
			await verifyRun(s.root, { json: false });
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		} finally {
			restore();
		}
		expect(`${threw}${lines.join("\n")}`).toMatch(/--vault-id requires a value/);
	});

	it("the --flag=value escape still allows a value that begins with a dash", async () => {
		// Refusing dash-leading values without an escape would make legitimate
		// ids unpassable, so the guard must not be a dead end.
		const s = await makeAnchoredVault(2);
		process.chdir(s.root);
		process.argv = [
			"node",
			"usertrust",
			"verify",
			"--vault-id=-weird-id",
			"--anchors",
			s.storeFile,
		];
		const { lines, restore } = captureLog();
		try {
			await verifyRun(s.root, { json: false });
		} finally {
			restore();
		}
		// It parsed as a vault id (mismatching this vault) rather than erroring
		// on the flag itself.
		expect(lines.join("\n")).not.toMatch(/requires a value/);
	});
});

describe("HARDEN: the flag-value guard must not eat documented syntax (#128-r3 F3)", () => {
	it('a bare "-" is still accepted as a value — it means stdin', async () => {
		// THE REGRESSION. Rejecting every leading dash to close the
		// `--vault-id --require-witness` hole also rejected `--anchor -`,
		// `--bundle -` and `--rekor-receipts -`, which are documented in
		// packages/verify/README.md and special-cased by readArtifact. A
		// security fix that silently deletes a working documented feature is
		// not a fix. Reject FLAGS, not dashes.
		const s = await makeAnchoredVault(2);
		process.chdir(s.root);
		process.argv = ["node", "usertrust", "verify", "--anchor", "-"];
		const { lines, restore } = captureLog();
		let threw = "";
		try {
			await verifyRun(s.root, { json: false });
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		} finally {
			restore();
		}
		// It must not be refused BY THE PARSER. (Reading stdin may fail for
		// other reasons in-process; what is pinned here is that "-" reached the
		// flag as its value.)
		expect(`${threw}${lines.join("\n")}`).not.toMatch(/--anchor requires a value/);
	});

	it("an empty inline value is a typo, not an empty path", async () => {
		// `--pubkey=` previously slid through and handed "" to readFileSync.
		const s = await makeAnchoredVault(2);
		process.chdir(s.root);
		process.argv = ["node", "usertrust", "verify", "--pubkey="];
		const { lines, restore } = captureLog();
		let threw = "";
		try {
			await verifyRun(s.root, { json: false });
		} catch (e) {
			threw = e instanceof Error ? e.message : String(e);
		} finally {
			restore();
		}
		expect(`${threw}${lines.join("\n")}`).toMatch(/--pubkey requires a value/);
	});
});
