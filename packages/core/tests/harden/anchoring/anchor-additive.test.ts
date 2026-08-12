// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — ANCHORING IS ADDITIVE (spec §9, AC-2/AC-3/AC-4)
 *
 * Anchoring must never change what the writer persists, what the pre-anchor
 * verifier sees, or the zero-dependency guarantee of packages/verify.
 */

import { readdirSync, readFileSync } from "node:fs";
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
		// point the reviewer asks what was added. Raised from 3200 for the
		// Phase-2 anchoring work (rekor-verify.ts, ~490 lines of node:crypto-only
		// receipt verification — no vendored source). Current size ~3.3k lines.
		// Raised 4200 → 6500 for the `usertrust-verify receipt` ship
		// (receipt-verify.ts, receipt-spec §7's offline verifier — node builtins
		// only, no vendored source).
		//
		// 6500 → 7200, on the authority of CLI spec §7's line-cap paragraph as
		// AMENDED 2026-08-12, which ratifies 7200, withdraws the "not a second
		// raise" clause ("it presumed the first number was right"), and restates
		// the LOC figure as a REVIEW PROMPT rather than a gate: crossing it
		// obliges (a) re-verifying the import and dependency assertions directly,
		// (b) recording here what was added and why it is not vendoring, and
		// (c) raising the number to fit the work rather than trimming the work
		// to fit the number. This comment discharges (b); assertions 4 and 5
		// above ARE (a), and both pass — every import in packages/verify/src is
		// still node:* or ./-relative and `dependencies` is still {}, so the
		// thing this tripwire exists to catch did not happen. Nothing was
		// trimmed: shaving prose off a Tier-0 verifier to fit a number games the
		// tripwire instead of satisfying it.
		//
		// What was added, and the arithmetic, counted by this test's own method
		// (split("\n").length per .ts file in packages/verify/src):
		//
		//   · pre-ship baseline (7d685e6, this branch's fork point): 8 files,
		//     3910 lines.
		//   · master has since moved to 3999 (+89) — anchor-verify.ts +54 AND
		//     index.ts +35, both master's own work on files this ship neither
		//     wrote nor (for the MIRRORED anchor-verify.ts) may edit.
		//   · this ship adds exactly one file: receipt-verify.ts, 2662 lines,
		//     receipt-spec §7 steps 1–9. No file was vendored; no mirrored file
		//     was edited.
		//   · post-merge total: 3999 + 2662 = 6661. Headroom under 7200: 539.
		//
		// Read the residual honestly rather than rounding it away. §7 derived
		// 7200 as baseline + a top-of-estimate 2600-line verifier + ~700 for the
		// CLI surface; the baseline came in +89 and the verifier +62 over that
		// estimate, so the 539 left for Task 5's CLI surface (cli.ts receipt
		// dispatch + the report module) was ~151 short of what §7 intended to
		// budget for it — and Task 5 did cross 7200, exactly as flagged.
		//
		// 7200 → 7500, Task 5 (2026-08-12), per the amended §7 process this
		// comment discharges (b) for: (a) is the re-run offender-list check
		// above (empty) plus a direct read of `dependencies: {}` in
		// package.json — both hold, so nothing was vendored. What was added:
		// `receipt-cli.ts` (new, 716 lines) — the CLI spec §2/§6 surface:
		// argument parsing, the `--envelope` R4 agreement check, the `--json`
		// and human report renderers (including the `sanitizeCliReport` pass
		// that scrubs untrusted text in BOTH output formats, not just the
		// human one), and the exit-code mapping, all `node:fs`/`./`-relative,
		// I/O-injected for testability without a dependency — plus +23 lines
		// in `cli.ts` for the `receipt` dispatch (must run before the vault
		// flag loop, CLI spec §2) and +5 in `receipt.ts` for exporting its
		// existing `forDisplay` sanitizer rather than writing a third copy
		// (CLI spec §6). Post-Task-5 total: 6661 + 716 + 23 + 5 = 7405. 7500
		// leaves 95 lines of headroom rather than shaving the report renderer
		// or the disclaimer strings to fit exactly — the spec's own
		// instruction is to raise the number to fit the work, not the
		// reverse.
		//
		// 7500 → 7800, the Codex Tier-0 review round (2026-08-12), same amended
		// §7 process. (a) re-verified directly: assertions 4 and 5 above are the
		// real invariant and both still pass — every import in
		// packages/verify/src is `node:*` or `./`-relative (the only new one is
		// `node:fs`'s `writeSync` in `receipt-cli.ts`) and `dependencies` is
		// still `{}`. (b) what was added, +219 lines across three files, all of
		// it CLOSING DEFECTS rather than adding surface:
		//   · `receipt-verify.ts` +164 — the frozen numeric rules moved onto the
		//     numeric LITERAL inside the pre-parse scanner (a fractional token
		//     `JSON.parse` rounds to a legal integer was verifying, because
		//     every value-level check ran after the rounding), the scan failure
		//     now carrying its class so a numeric refusal is SCHEMA_INVALID and
		//     not UNVERIFIABLE, `structurallyEqualJson` for R4, non-empty
		//     required strings, `-0` refused where §13 forbids it, and the
		//     checkpoint key's `alg` bound to ed25519 as the mint path already
		//     binds it. Roughly half of those lines are the comments explaining
		//     why each rule cannot be checked where it used to be.
		//   · `receipt-cli.ts` +42 — `writeAllSync` (the `| jq` contract:
		//     `process.exit` does not drain an async pipe), R4 through the
		//     structural comparison, and option tokens refused where a value is
		//     required.
		//   · `cli.ts` +13 — routing the receipt branch's output through
		//     `writeAllSync` before the exit.
		// Post-review total: 7670. 7800 leaves 130 lines of headroom.
		//
		// 7800 → 8400, the Codex Tier-0 FORMAT round (2026-08-12), same amended
		// §7 process. (a) re-verified directly: assertions 4 and 5 above still
		// pass — every import in `packages/verify/src` is `node:*` or
		// `./`-relative and `dependencies` is still `{}`; no file was vendored
		// and no mirrored file was edited. (b) what was added, +509 lines across
		// two files, all of it closing ONE defect class:
		//   · `receipt-verify.ts` +496 — the FIELD TABLE. Two review rounds
		//     found nine soundness holes that were one hole nine times: the
		//     reader checked STRUCTURE and never FORMAT, so `<64 hex>zz` folded
		//     to the same root (Node's hex decoder drops the tail),
		//     `startedAt: "not-a-date"` verified, and `sourceReservationReceiptId`
		//     named nothing. The fix is not nine checks: the key SET and the
		//     declared FORMAT are now one declaration per member, walked once for
		//     both purposes, with the owning §7 step recorded per field so step 1
		//     cannot pre-empt an equality. The line cost is the table itself
		//     (~180 lines of declarations, one per member of §5's document) plus
		//     the format predicates and the prose deriving each from spec text —
		//     which is the artifact that makes the class closed instead of the
		//     next round's tenth instance. Also here: §8's retirement boundary
		//     read across the rotation LINK (an `active` key with a declared
		//     successor has no boundary, so a rotated-away key could sign
		//     forever), and `--expect-id` reporting `unavailable` rather than
		//     `notApplicable` when the run never reached step 3.
		//   · `receipt-cli.ts` +13 — threading that arrival result through the
		//     pre-run report, where nothing ran at all.
		// Post-round total: 8192. 8400 leaves 208 lines of headroom rather than
		// trimming a Tier-0 table to fit a number.
		//
		// 8400 → 8700, the THIRD Codex Tier-0 round (2026-08-12), same amended §7
		// process. (a) re-verified directly: assertions 4 and 5 above still pass —
		// every import in `packages/verify/src` is `node:*` or `./`-relative
		// (`node:crypto`, `node:fs`, `node:path`, and nothing else) and
		// `dependencies` is still `{}`; no file was vendored and no mirrored file
		// was edited. (b) what was added, +209 lines across two files, every line
		// of it closing a defect:
		//   · `receipt-verify.ts` +157 — a REGRESSION the previous round
		//     introduced plus three P1s of one class. The regression:
		//     `walkFieldTable` asked `table[key] !== undefined`, and a plain
		//     object answers that with `Object.prototype`, so a signed member
		//     named `__proto__`/`constructor`/`toString` read as DECLARED and
		//     reached VERIFIED_CHECKPOINT — fixed with `Object.hasOwn` plus
		//     null-prototype tables (`fieldTable`), which is why the defect is now
		//     inexpressible rather than merely absent. The class: AGREEMENT IS NOT
		//     CONFORMANCE — §4a's fixed `event.actor`, §4a/§8's `minter.kind`
		//     literal, and §8's one-material-one-keyId rule, each of which the
		//     verifier had been deciding by comparing two attacker-supplied
		//     documents to each other. Plus PRESENT-but-malformed `proof`/
		//     `inclusion`/`checkpoint` moving from UNVERIFIABLE (exit 2) to
		//     SCHEMA_INVALID (exit 1), which is the CI contract. Most of the count
		//     is the prose recording WHY each rule cannot be an agreement, so the
		//     fourth instance reads as an instance.
		//   · `receipt-cli.ts` +38 — R4 agreement no longer gated on the receipt
		//     schema (a resolver could rewrite its own framing for free whenever
		//     the bytes failed §5), and `pushCheck`, which prints a failed §7
		//     check's nested DETAIL: step 9 is upgrade-only, so `report.failure`
		//     is null and the human report had nowhere else to say whether the
		//     history was short, broken at an edge, or signed by the wrong key.
		// Post-round total: 8401. 8700 leaves 299 lines of headroom.
		let total = 0;
		for (const file of readdirSync(VERIFY_SRC).filter((f) => f.endsWith(".ts"))) {
			total += readFileSync(join(VERIFY_SRC, file), "utf-8").split("\n").length;
		}
		expect(total).toBeLessThan(8700);
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
