import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/report.js";

// The flag the mocked fs consults: when set, copying the queue INTO the report's snapshot fails with ENOENT, the way a
// temp directory reaped between its creation and the write would.
const failCopy = vi.hoisted(() => ({ on: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		writeFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (
				failCopy.on &&
				typeof path === "string" &&
				path.includes("usertrust-report-") &&
				path.endsWith("dead-letters.jsonl")
			) {
				throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
			}
			return (actual.writeFileSync as (...a: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.writeFileSync,
	};
});

describe("a failed copy of the dead-letter queue into the snapshot is never read as 'no queue'", () => {
	let dir: string;
	let stdout: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "report-copy-"));
		stdout = "";
		failCopy.on = false;
		vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
		process.exitCode = undefined;
	});
	afterEach(() => {
		failCopy.on = false;
		vi.restoreAllMocks();
		process.exitCode = undefined;
		rmSync(dir, { recursive: true, force: true });
	});

	/** tx_kept on the chain from writer A; tx_lost from writer B: rejected and dead-lettered. */
	async function vaultWithOneLostEvent(): Promise<void> {
		mkdirSync(join(dir, ".usertrust", "audit"), { recursive: true });
		const a = createAuditWriter(dir);
		const b = createAuditWriter(dir);
		try {
			await a.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_kept" } });
			await expect(
				b.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "tx_lost" } }),
			).rejects.toThrow();
		} finally {
			a.release();
			b.release();
		}
	}

	const report = async () => {
		stdout = "";
		await run(dir, {}, [
			"--week",
			"--end",
			new Date(Date.now() + 3_600_000).toISOString(),
			"--format",
			"json",
		]);
		return JSON.parse(stdout) as { integrity: { verified: boolean; errors: string[] } };
	};

	it("CONTROL: the copy works, and the lost event makes the vault INCOMPLETE", async () => {
		await vaultWithOneLostEvent();
		const out = await report();
		expect(out.integrity.verified).toBe(false);
		expect(out.integrity.errors.join("\n")).toContain("INCOMPLETE:");
	});

	it("the copy fails with ENOENT: the vault is NOT verified (INCOMPLETE?), never cleared as having no queue", async () => {
		await vaultWithOneLostEvent();
		failCopy.on = true;
		const out = await report();
		expect(out.integrity.verified).toBe(false);
		expect(out.integrity.errors.join("\n")).toContain("INCOMPLETE?");
		expect(out.integrity.errors.join("\n")).toContain("could not copy the queue");
		expect(process.exitCode).toBe(2);
	});
});
