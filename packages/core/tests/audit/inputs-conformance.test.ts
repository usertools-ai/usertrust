import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { readChainDeadLetters } from "../../src/audit/dead-letters.js";
import { MAIN_LOG, verifierInputs } from "../../src/audit/inputs.js";
import { verifyVault } from "../../src/audit/verify.js";

// EVERY fs touch the verifier could make, recorded by path: reads, listings, existence and type checks, opens, streams and
// the promise API. A touch outside `verifierInputs` (plus the directories it lists) changes this record.
const touched = vi.hoisted(() => ({
	paths: [] as string[],
	dirs: [] as string[],
	ops: [] as Array<{ op: string; path: string }>,
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const wrap = (name: string, isListing = false) =>
		((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string") {
				(isListing ? touched.dirs : touched.paths).push(path);
				touched.ops.push({ op: name, path });
			}
			return (
				(actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name] as (
					...a: unknown[]
				) => unknown
			)(path, ...rest);
		}) as never;
	return {
		...actual,
		readFileSync: wrap("readFileSync"),
		existsSync: wrap("existsSync"),
		statSync: wrap("statSync"),
		lstatSync: wrap("lstatSync"),
		openSync: wrap("openSync"),
		accessSync: wrap("accessSync"),
		createReadStream: wrap("createReadStream"),
		readdirSync: wrap("readdirSync", true),
	};
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const wrap = (name: string) =>
		((path: unknown, ...rest: unknown[]) => {
			if (typeof path === "string") {
				touched.paths.push(path);
				touched.ops.push({ op: `promises.${name}`, path });
			}
			return (
				(actual as unknown as Record<string, (...a: unknown[]) => unknown>)[name] as (
					...a: unknown[]
				) => unknown
			)(path, ...rest);
		}) as never;
	return {
		...actual,
		readFile: wrap("readFile"),
		stat: wrap("stat"),
		lstat: wrap("lstat"),
		open: wrap("open"),
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
		touched.paths.length = 0;
		touched.dirs.length = 0;
		touched.ops.length = 0;
	});
	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Build a vault holding every input AND decoys the verifier must not touch. Returns the vault dir. */
	async function sampleVault(): Promise<string> {
		mkdirSync(join(root, ".usertrust", "audit"), { recursive: true });
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { transferId: "t1", cost: 1 } });
		w.release();
		const vault = join(root, ".usertrust");
		const audit = join(vault, "audit");
		writeFileSync(join(audit, "events-2026-10.jsonl"), "");
		mkdirSync(join(vault, "dlq"), { recursive: true });
		writeFileSync(join(vault, "dlq", "dead-letters.jsonl"), "");
		writeFileSync(join(audit, "index.json"), "{}");
		writeFileSync(join(audit, "events-2026-10.jsonl.meta"), "{}");
		mkdirSync(join(audit, "anchors"), { recursive: true });
		writeFileSync(join(audit, "anchors", "a.json"), "{}");
		writeFileSync(join(vault, "spend-ledger.json"), "{}");
		writeFileSync(join(vault, "usertrust.config.json"), "{}");
		return vault;
	}

	/** The paths (relative to the vault) touched since the record was last cleared, outside the allowed set. */
	function outsideAllowed(vault: string, listed: string[]): string[] {
		const allowed = new Set([...listed, "", "audit", "dlq"]);
		return [...new Set(touched.paths.concat(touched.dirs).map((p) => relative(vault, p)))]
			.filter((p) => !p.startsWith("..") && !allowed.has(p))
			.sort();
	}

	it("verifyVault + the completeness reader touch the listed inputs and nothing else, by any fs call", async () => {
		const vault = await sampleVault();
		// the listing comes from the REAL directory, not from a hand-typed list that could agree with the code by construction
		const listing = readdirSync(join(vault, "audit"));
		const listed = verifierInputs(listing).map((i) => i.rel);

		touched.paths.length = 0;
		touched.dirs.length = 0;
		touched.ops.length = 0;
		verifyVault(vault);
		readChainDeadLetters(vault, () => undefined);

		// 1. every path touched, by ANY call (exists/stat/open/read/stream), is a listed input or one of the directories
		expect(outsideAllowed(vault, listed)).toEqual([]);
		// 2. the CONTENT reads are exactly the listed inputs (equality: a recorder that missed readFileSync would fail here)
		const contentReads = [
			...new Set(
				touched.ops.filter((o) => o.op === "readFileSync").map((o) => relative(vault, o.path)),
			),
		].sort();
		expect(contentReads).toEqual([...listed].sort());
		// 3. the only directory it lists is the audit directory
		expect([...new Set(touched.dirs.map((d) => relative(vault, d)))]).toEqual(["audit"]);
	});

	it("POSITIVE CONTROL: the recorder sees an existence check on an unlisted path, so a future one turns the row red", async () => {
		const vault = await sampleVault();
		const listed = verifierInputs(readdirSync(join(vault, "audit"))).map((i) => i.rel);
		touched.paths.length = 0;
		touched.dirs.length = 0;
		touched.ops.length = 0;
		verifyVault(vault);
		// what a verdict-bearing existsSync added to the verifier would look like
		existsSync(join(vault, "audit", "index.json"));
		expect(outsideAllowed(vault, listed)).toEqual(["audit/index.json"]);
		readFileSync(join(vault, "spend-ledger.json"));
		expect(outsideAllowed(vault, listed)).toEqual(["audit/index.json", "spend-ledger.json"]);
	});

	it("the verifier's modules import fs only as node:fs or node:fs/promises, which the recorder wraps", () => {
		const dir = fileURLToPath(new URL("../../src/audit/", import.meta.url));
		for (const file of ["verify.ts", "dead-letters.ts", "inputs.ts", "canonical.ts"]) {
			const text = readFileSync(join(dir, file), "utf-8");
			const bare = [...text.matchAll(/from\s+["']([^"']+)["']/g)]
				.map((m) => m[1] as string)
				.filter((spec) => /^(fs|fs\/promises)$/.test(spec));
			expect(bare, `${file} imports fs without the node: prefix`).toEqual([]);
		}
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
