// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the documentation says verification does and does NOT catch, pinned.
 *
 * Several public sentences about the audit chain were wrong in the same way:
 * they said more than verification does. "Any mutated, reordered, or inserted
 * event breaks verification" was false for a physical reordering (the verifiers
 * order events by `sequence`), "a shorter-but-internally-consistent chain no
 * longer passes" was false once `.meta` is rewritten, and the README's sample
 * output dropped the UNANCHORED qualifier the CLI prints. Each of those
 * sentences had nothing that failed when it stopped being true.
 *
 * Every row here is a sentence the docs now state, as a test. The rows that
 * show what an UNANCHORED vault does not catch are as important as the rows
 * that show what it does: if verification gets stronger, those rows fail and
 * the caveats in the docs get updated with them, rather than going stale. Each
 * row runs both verifiers (core and the zero-dependency package), which must
 * agree. The register in docs/claims.json cites these rows by title.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyVault as pkgVerifyVault } from "../../../verify/src/index.js";
import {
	buildMerkleTree as pkgBuildMerkleTree,
	generateConsistencyProof as pkgGenerateConsistencyProof,
	verifyConsistencyProof as pkgVerifyConsistencyProof,
} from "../../../verify/src/verify.js";
import { canonicalize } from "../../src/audit/canonical.js";
import { createAuditWriter } from "../../src/audit/chain.js";
import {
	buildMerkleTree as coreBuildMerkleTree,
	generateConsistencyProof as coreGenerateConsistencyProof,
	verifyConsistencyProof as coreVerifyConsistencyProof,
} from "../../src/audit/merkle.js";
import { verifyVault as coreVerifyVault } from "../../src/audit/verify.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A vault the real writer produced, with `n` events. Returns the project root. */
async function writerVault(n: number): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "claims-pins-"));
	dirs.push(root);
	const w = createAuditWriter(root);
	for (let i = 1; i <= n; i++) {
		await w.appendEvent({ kind: "llm_call", actor: "sys", data: { n: i } });
	}
	w.release();
	return root;
}

const logOf = (root: string) => join(root, VAULT_DIR, "audit", "events.jsonl");

function readEvents(root: string): Record<string, unknown>[] {
	return readFileSync(logOf(root), "utf-8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

function writeEvents(root: string, events: Record<string, unknown>[]): void {
	writeFileSync(logOf(root), `${events.map((e) => canonicalize(e)).join("\n")}\n`);
}

/** The `.meta` sidecar rewritten to match the log's last event, as anyone with write access can. */
function rewriteMeta(root: string): void {
	const events = readEvents(root);
	const last = events.at(-1) as { hash: string; sequence: number };
	writeFileSync(
		`${logOf(root)}.meta`,
		JSON.stringify({ lastHash: last.hash, sequence: last.sequence }),
	);
}

/** Re-hash the chain from its first event, keeping each event's content, as a forger would. */
function rechain(events: Record<string, unknown>[]): Record<string, unknown>[] {
	let previousHash = "0".repeat(64);
	return events.map((e) => {
		const { hash: _old, ...rest } = e;
		const body = { ...rest, previousHash };
		const hash = createHash("sha256").update(canonicalize(body)).digest("hex");
		previousHash = hash;
		return { ...body, hash };
	});
}

/** Both verifiers, which must agree on the verdict and the errors. */
function verdict(root: string): { valid: boolean; chainLength: number; errors: string[] } {
	const core = coreVerifyVault(join(root, VAULT_DIR));
	const pkg = pkgVerifyVault(join(root, VAULT_DIR));
	expect(core.valid).toBe(pkg.valid);
	expect(core.chainLength).toBe(pkg.chainLength);
	expect(core.errors).toEqual(pkg.errors);
	return { valid: core.valid, chainLength: core.chainLength, errors: core.errors };
}

describe("what verification catches on an unanchored vault, as the docs state it", () => {
	it("a clean writer vault verifies (the control for every row below)", async () => {
		const root = await writerVault(4);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 4, errors: [] });
	});

	it("the writer only appends: each append leaves every earlier byte of events.jsonl as it was", async () => {
		const root = mkdtempSync(join(tmpdir(), "claims-pins-"));
		dirs.push(root);
		const w = createAuditWriter(root);
		let before = Buffer.alloc(0);
		for (let i = 1; i <= 4; i++) {
			await w.appendEvent({ kind: "llm_call", actor: "sys", data: { n: i } });
			const after = readFileSync(logOf(root));
			expect(after.length).toBeGreaterThan(before.length);
			expect(after.subarray(0, before.length).equals(before)).toBe(true);
			before = after;
		}
		w.release();
	});

	it("deleting one event from the middle of the chain fails verification", async () => {
		const root = await writerVault(4);
		const events = readEvents(root);
		writeEvents(root, [...events.slice(0, 1), ...events.slice(2)]);
		const v = verdict(root);
		expect(v.valid).toBe(false);
		expect(v.errors.join("\n")).toMatch(/previousHash|Sequence gap/);
	});

	it("an event inserted in the middle of the chain, without re-hashing what follows, fails verification", async () => {
		const root = await writerVault(4);
		const events = readEvents(root);
		const before = events[1] as { hash: string };
		const forged = rechain([
			...events.slice(0, 2),
			{
				id: "forged",
				timestamp: new Date().toISOString(),
				kind: "llm_call",
				actor: "sys",
				data: {},
				sequence: 3,
			},
		]).at(-1) as Record<string, unknown>;
		expect(forged.previousHash).toBe(before.hash);
		writeEvents(root, [...events.slice(0, 2), forged, ...events.slice(2)]);
		expect(verdict(root).valid).toBe(false);
	});

	it("an edited event fails verification", async () => {
		const root = await writerVault(3);
		const events = readEvents(root);
		(events[1] as { data: unknown }).data = { n: 999 };
		writeEvents(root, events);
		const v = verdict(root);
		expect(v.valid).toBe(false);
		expect(v.errors.join("\n")).toMatch(/hash mismatch/i);
	});

	it("emptying events.jsonl while .meta remains: the next append continues from the sidecar, and verification reports the gap", async () => {
		const root = await writerVault(3);
		writeFileSync(logOf(root), "");
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "llm_call", actor: "sys", data: { n: 4 } });
		w.release();
		const v = verdict(root);
		expect(v.valid).toBe(false);
		expect(v.errors).toContain("Sequence starts at 4, expected 1 (leading events deleted)");
	});
});

describe("what an unanchored vault does NOT catch, as the docs state it (each row fails if verification gets stronger)", () => {
	it("moving lines around in the file without changing any event is not reported: events are checked in sequence order", async () => {
		const root = await writerVault(4);
		const events = readEvents(root);
		writeEvents(root, [events[0], events[2], events[1], events[3]] as Record<string, unknown>[]);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 4, errors: [] });
	});

	it("a log cut short whose .meta is rewritten to match verifies as valid", async () => {
		const root = await writerVault(4);
		writeEvents(root, readEvents(root).slice(0, 2));
		rewriteMeta(root);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 2, errors: [] });
	});

	it("a log cut short whose .meta is deleted verifies as valid", async () => {
		const root = await writerVault(4);
		writeEvents(root, readEvents(root).slice(0, 2));
		rmSync(`${logOf(root)}.meta`);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 2, errors: [] });
	});

	it("a cut log is reported until a new writer appends after the cut, which rewrites .meta; then the shorter chain verifies", async () => {
		const root = await writerVault(4);
		writeEvents(root, readEvents(root).slice(0, 2));
		expect(verdict(root).valid).toBe(false); // .meta still records 4 events
		const w = createAuditWriter(root);
		await w.appendEvent({ kind: "llm_call", actor: "sys", data: { n: 5 } });
		w.release();
		expect(verdict(root)).toEqual({ valid: true, chainLength: 3, errors: [] });
	});

	it("an event added after the last one, with .meta rewritten to match, verifies like any other", async () => {
		const root = await writerVault(3);
		const events = readEvents(root);
		const forged = rechain([
			...events,
			{
				id: "forged",
				timestamp: new Date().toISOString(),
				kind: "llm_call",
				actor: "sys",
				data: {},
				sequence: 4,
			},
		]);
		expect(forged.slice(0, 3)).toEqual(events);
		writeEvents(root, forged);
		rewriteMeta(root);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 4, errors: [] });
	});

	it("an edited event whose chain is re-hashed from the start, with .meta rewritten, verifies as valid", async () => {
		const root = await writerVault(3);
		const events = readEvents(root);
		(events[0] as { data: unknown }).data = { n: 999 };
		writeEvents(root, rechain(events));
		rewriteMeta(root);
		expect(verdict(root)).toEqual({ valid: true, chainLength: 3, errors: [] });
	});
});

describe("a consistency proof means something only against a root obtained independently", () => {
	const leaves = (tag: string, n: number) =>
		Array.from({ length: n }, (_, i) => createHash("sha256").update(`${tag}-${i}`).digest("hex"));

	for (const [label, build, generate, verify] of [
		["core", coreBuildMerkleTree, coreGenerateConsistencyProof, coreVerifyConsistencyProof],
		["verify package", pkgBuildMerkleTree, pkgGenerateConsistencyProof, pkgVerifyConsistencyProof],
	] as const) {
		it(`${label}: a proof built from a rewritten log verifies on its own, and fails against the original root`, () => {
			const original = leaves("original", 8);
			const rewritten = leaves("rewritten", 8);
			const originalRoot = build(original.slice(0, 5)).root as string;

			const forged = generate(5, 8, rewritten);
			expect(verify(forged)).toBe(true); // proves nothing about tampering by itself
			expect(forged.firstRoot).not.toBe(originalRoot);
			expect(verify({ ...forged, firstRoot: originalRoot })).toBe(false);

			// The control: an honest extension of the original log verifies against its root.
			const honest = generate(5, 8, original);
			expect(honest.firstRoot).toBe(originalRoot);
			expect(verify(honest)).toBe(true);
		});
	}
});

describe("the documented sample output is what the CLI prints", () => {
	it("every 'Vault integrity:' line in the READMEs and the quickstart is the line usertrust-verify prints for a clean unanchored vault", async () => {
		const root = await writerVault(2);
		const res = spawnSync(
			join(REPO_ROOT, "node_modules", ".bin", "tsx"),
			[join(REPO_ROOT, "packages", "verify", "src", "cli.ts"), join(root, VAULT_DIR)],
			{ cwd: REPO_ROOT, encoding: "utf-8" },
		);
		expect(res.status, res.stderr).toBe(0);
		const printed = res.stdout.split("\n")[0] as string;
		expect(printed).toMatch(/^Vault integrity: VERIFIED/);

		const samples: string[] = [];
		for (const rel of [
			"README.md",
			"packages/core/README.md",
			"packages/verify/README.md",
			"site/content/docs/quickstart.mdx",
		]) {
			const lines = readFileSync(join(REPO_ROOT, rel), "utf-8").split("\n");
			const found = lines.filter((l) => l.startsWith("Vault integrity:"));
			expect(found.length, `${rel} has no sample line`).toBeGreaterThan(0);
			samples.push(...found.map((l) => `${rel}: ${l}`));
		}
		for (const s of samples) expect(s.slice(s.indexOf(": ") + 2), s).toBe(printed);
		// timing: 60 s for one CLI run and four file reads; CI's test job took 307 ms, and 433 ms
		// under coverage, in #452.
	}, 60_000);
});
