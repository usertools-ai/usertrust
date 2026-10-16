import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import { verifyVaultComplete } from "../../src/audit/complete.js";
import { deadLetterPath, readChainDeadLetters } from "../../src/audit/dead-letters.js";

/**
 * `verifyVaultComplete` is the ONE verdict `usertrust verify` and `usertrust report` both print: integrity AND completeness,
 * on the live vault, with the dead letters judged against the events the verifier walked.
 */
describe("verifyVaultComplete", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "complete-"));
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});
	const vault = () => join(root, ".usertrust");

	const sealed = (entry: Record<string, unknown>): string => {
		const checksum = createHash("sha256").update(canonicalize(entry)).digest("hex");
		return JSON.stringify({ ...entry, checksum, checksumAlg: "sha256" });
	};
	const letter = (source: string, payload: unknown) =>
		sealed({ source, payload, error: "disk full", timestamp: "2026-10-08T01:00:00.000Z" });

	async function chainOfOne(): Promise<void> {
		mkdirSync(join(vault(), "audit"), { recursive: true });
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "t1", cost: 1 } });
		w.release();
	}

	it("a clean vault is valid and complete, and hands back the events it walked", async () => {
		await chainOfOne();
		const v = verifyVaultComplete(vault());
		expect(v.valid).toBe(true);
		expect(v.complete).toBe(true);
		expect(v.errors).toEqual([]);
		expect(v.reading.events).toHaveLength(1);
	});

	it("a dead-lettered chain event that is not on the chain makes it INCOMPLETE, though the chain verifies link by link", async () => {
		await chainOfOne();
		mkdirSync(join(vault(), "dlq"), { recursive: true });
		writeFileSync(
			deadLetterPath(vault()),
			`${letter("audit.chain.appendEvent", { kind: "llm_call", actor: "local", data: { transferId: "lost" } })}\n`,
		);
		const v = verifyVaultComplete(vault());
		expect(v.reading.result.valid).toBe(true);
		expect(v.complete).toBe(false);
		expect(v.valid).toBe(false);
		expect(v.errors.join("\n")).toContain("INCOMPLETE:");
	});

	it("an unreadable queue line is INCOMPLETE? (unknown), never clean", async () => {
		await chainOfOne();
		mkdirSync(join(vault(), "dlq"), { recursive: true });
		writeFileSync(deadLetterPath(vault()), "{not json\n");
		const v = verifyVaultComplete(vault());
		expect(v.valid).toBe(false);
	});

	it("shortfalls come from the SAME lines as the completeness count; another source and a malformed one are handled", async () => {
		await chainOfOne();
		mkdirSync(join(vault(), "dlq"), { recursive: true });
		const shortfall = (tid: string, posted: unknown) => ({
			kind: "settlement_shortfall",
			actor: "local",
			data: { transferId: tid, actual: 100, posted, shortfall: 40 },
		});
		writeFileSync(
			deadLetterPath(vault()),
			`${[
				letter("audit.chain.appendEvent", shortfall("a", 60)),
				// another source: not a chain event, never a shortfall
				letter("ledger.engine.postSettlement", shortfall("b", 10)),
			].join("\n")}\n`,
		);
		const ok = readChainDeadLetters(vault(), () => undefined);
		if ("unreadable" in ok) throw new Error("queue unreadable");
		expect([...ok.shortfalls]).toEqual([["a", 60]]);
		expect(ok.shortfallsReliable).toBe(true);
		expect(ok.otherSources).toBe(1);
		// a chain-source shortfall whose amount is not a count makes the amounts unreliable
		writeFileSync(
			deadLetterPath(vault()),
			`${letter("audit.chain.appendEvent", shortfall("c", "sixty"))}\n`,
		);
		const bad = readChainDeadLetters(vault(), () => undefined);
		if ("unreadable" in bad) throw new Error("queue unreadable");
		expect(bad.shortfallsReliable).toBe(false);
	});
});
