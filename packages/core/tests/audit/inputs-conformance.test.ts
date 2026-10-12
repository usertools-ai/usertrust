import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { MAIN_LOG, verifierInputs } from "../../src/audit/inputs.js";
import { verifyVault } from "../../src/audit/verify.js";

// Every file the verifier opens, recorded. A read added to the verifier outside `verifierInputs` changes this set.
const reads = vi.hoisted(() => ({ files: [] as string[], dirs: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string") reads.files.push(path);
			return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.readFileSync,
		readdirSync: ((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string") reads.dirs.push(path);
			return (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.readdirSync,
	};
});

/**
 * THE LIST IS WHAT THE VERIFIER READS. The weekly report copies exactly `verifierInputs` into its snapshot and judges the
 * copy; if the verifier ever reads something else, a snapshot without it would report VERIFIED over a vault `verify` fails.
 * This runs the verifier over a vault that holds every input AND decoys it must not read, with its file reads recorded.
 */
describe("the verifier reads exactly the listed inputs", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "inputs-conf-"));
		reads.files.length = 0;
		reads.dirs.length = 0;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("verifyVault + the completeness reader read the listed set and nothing else", async () => {
		mkdirSync(join(root, ".usertrust", "audit"), { recursive: true });
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "t1", cost: 1 } });
		w.release();
		const vault = join(root, ".usertrust");
		const audit = join(vault, "audit");
		// a rotated segment, a queue, and DECOYS the verifier must not open
		writeFileSync(join(audit, "events-2026-10.jsonl"), "");
		mkdirSync(join(vault, "dlq"), { recursive: true });
		writeFileSync(join(vault, "dlq", "dead-letters.jsonl"), "");
		writeFileSync(join(audit, "index.json"), "{}");
		writeFileSync(join(audit, "events-2026-10.jsonl.meta"), "{}");
		mkdirSync(join(audit, "anchors"), { recursive: true });
		writeFileSync(join(audit, "anchors", "a.json"), "{}");
		writeFileSync(join(vault, "spend-ledger.json"), "{}");
		writeFileSync(join(vault, "usertrust.config.json"), "{}");

		reads.files.length = 0;
		reads.dirs.length = 0;
		verifyVault(vault);
		readChainDeadLetters(vault, () => undefined);

		const read = [...new Set(reads.files.map((f) => relative(vault, f)))].sort();
		const listed = verifierInputs(["events-2026-10.jsonl", "index.json", "anchors"])
			.map((i) => i.rel)
			.sort();
		expect(read).toEqual(listed);
		// and the only directory it lists is the audit directory
		expect([...new Set(reads.dirs.map((d) => relative(vault, d)))]).toEqual(["audit"]);
	});

	it("the list names the main log and its sidecar even when neither exists, and every segment present", () => {
		const names = verifierInputs([
			"b.jsonl",
			"events.jsonl",
			"a.jsonl",
			"events.jsonl.meta",
			"x.txt",
		]).map((i) => i.rel);
		expect(names).toEqual([
			`audit/${MAIN_LOG}`,
			`audit/${MAIN_LOG}.meta`,
			"audit/a.jsonl",
			"audit/b.jsonl",
			"dlq/dead-letters.jsonl",
		]);
		expect(verifierInputs([]).map((i) => i.rel)).toEqual([
			`audit/${MAIN_LOG}`,
			`audit/${MAIN_LOG}.meta`,
			"dlq/dead-letters.jsonl",
		]);
	});
});
