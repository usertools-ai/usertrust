// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — ANCHORING IS ADDITIVE (spec §9, AC-2/AC-3/AC-4)
 *
 * Anchoring must never change what the writer persists, what the pre-anchor
 * verifier sees, or the zero-dependency guarantee of packages/verify.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyVault as pkgVerifyVault } from "../../../../verify/src/index.js";
import {
	verifyVault as coreVerifyVault,
	verifyVaultWithAnchors,
} from "../../../src/audit/verify.js";
import { VAULT_DIR } from "../../../src/shared/constants.js";
import { anchorOnce, appendEvents, cleanupAll, makeAnchoredVault, tmp } from "./fixtures.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..", "..");
const VERIFY_SRC = join(REPO_ROOT, "packages", "verify", "src");

afterEach(() => {
	cleanupAll();
});

describe("HARDEN: anchoring additive proofs", () => {
	it("1. AC-3.2: anchoring never touches events.jsonl or .meta bytes", async () => {
		const s = await makeAnchoredVault(5);
		const logPath = join(s.vaultPath, "audit", "events.jsonl");
		const metaPath = `${logPath}.meta`;
		const logBefore = readFileSync(logPath);
		const metaBefore = readFileSync(metaPath);

		await anchorOnce(s);

		expect(readFileSync(logPath).equals(logBefore)).toBe(true);
		expect(readFileSync(metaPath).equals(metaBefore)).toBe(true);
	});

	it("2. AC-3.3: the pre-anchor verifier still passes on an anchored vault; anchors never enter the segment glob", async () => {
		const s = await makeAnchoredVault(4);
		const before = coreVerifyVault(s.vaultPath);
		await anchorOnce(s);

		const core = coreVerifyVault(s.vaultPath);
		const pkg = pkgVerifyVault(s.vaultPath);
		expect(core.valid).toBe(true);
		expect(pkg.valid).toBe(true);
		expect(core.chainLength).toBe(before.chainLength);
		expect(core.merkleRoot).toBe(before.merkleRoot);

		// The emitter must never create *.jsonl files directly in audit/ —
		// the existing verifiers glob those as chain segments (AC-3.3).
		const auditEntries = readdirSync(join(s.vaultPath, "audit"));
		const jsonlEntries = auditEntries.filter((e) => e.endsWith(".jsonl"));
		expect(jsonlEntries).toEqual(["events.jsonl"]);
		expect(auditEntries).toContain("anchors");
	});

	it("3. AC-4.1: legacy vault (no anchors, no flags) → valid, UNANCHORED, additive fields present", async () => {
		const root = tmp("additive-legacy-");
		await appendEvents(root, 3);
		const result = verifyVaultWithAnchors(join(root, VAULT_DIR));
		expect(result.valid).toBe(true);
		expect(result.anchorState).toBe("UNANCHORED");
		expect(result.anchoring.anchorSource).toBe("none");
		// Existing fields keep today's meanings (additive-only result shape).
		expect(result.chainLength).toBe(3);
		expect(result.errors).toEqual([]);
	});

	it("4. AC-2.1: packages/verify dependencies stay exactly {} (no peer/optional smuggling)", () => {
		const pkg = JSON.parse(
			readFileSync(join(REPO_ROOT, "packages", "verify", "package.json"), "utf-8"),
		) as Record<string, unknown>;
		expect(pkg.dependencies).toEqual({});
		expect(pkg.peerDependencies).toBeUndefined();
		expect(pkg.optionalDependencies).toBeUndefined();
	});

	it("5. AC-2.2: every import in packages/verify/src resolves to node:* or a sibling file", () => {
		const offenders: string[] = [];
		for (const file of readdirSync(VERIFY_SRC).filter((f) => f.endsWith(".ts"))) {
			const source = readFileSync(join(VERIFY_SRC, file), "utf-8");
			for (const match of source.matchAll(/from\s+"([^"]+)"|import\s*\(\s*"([^"]+)"\s*\)/g)) {
				const spec = match[1] ?? match[2] ?? "";
				if (!spec.startsWith("node:") && !spec.startsWith("./")) {
					offenders.push(`${file}: ${spec}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	it("6. AC-2.2 vendoring guard: packages/verify/src stays within its conscious LOC budget", () => {
		// The import lint above is structurally blind to vendored source (a
		// vendored crypto file IS a sibling file). This budget is a tripwire:
		// growing past it requires consciously editing this number — at which
		// point the reviewer asks what was added. Current size ~2.6k lines.
		let total = 0;
		for (const file of readdirSync(VERIFY_SRC).filter((f) => f.endsWith(".ts"))) {
			total += readFileSync(join(VERIFY_SRC, file), "utf-8").split("\n").length;
		}
		expect(total).toBeLessThan(3200);
	});

	it("7. mirror parity: anchor-verify.ts is byte-identical across packages modulo import paths", () => {
		const strip = (s: string): string =>
			s
				.split("\n")
				.filter((l) => !l.includes('from "'))
				.join("\n");
		const pkgCopy = readFileSync(join(VERIFY_SRC, "anchor-verify.ts"), "utf-8");
		const coreCopy = readFileSync(
			join(REPO_ROOT, "packages", "core", "src", "audit", "anchor-verify.ts"),
			"utf-8",
		);
		expect(strip(coreCopy)).toBe(strip(pkgCopy));
	});
});
