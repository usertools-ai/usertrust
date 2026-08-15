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
		// Post-round total: 8594. 8700 leaves 106 lines of headroom. (Recorded
		// 2026-08-12 after the stdin round; the previous figure of 8401 had gone
		// two rounds stale. The number in this comment is the artifact CLI spec
		// §7 requires, so it is only honest if it is recomputed, not carried.)
		//
		// Rounds 4–6 under the same 8700 ceiling and the same amended §7 process
		// — recorded here rather than each raising the number, because the
		// headroom held. (a) re-verified at each: assertions 4 and 5 above still
		// pass, `dependencies` is still `{}`, no file was vendored and no
		// mirrored file was edited. (b) what was added, all of it closing Codex
		// Tier-0 findings, none of it new surface:
		//   · round 4 (16dc595, +1) — the arrival-context regating and the
		//     absent/malformed split; the total this comment first recorded.
		//   · round 5 (7ca7c44, +67) — `receipt-verify.ts` +35, `receipt-cli.ts`
		//     +32: a malformed `--expect-id` trailer is a usage error, not an
		//     arrival check that fails, and the caveat set follows the posture.
		//   · round 6 (908907b, +97) — `receipt-verify.ts` +82, `receipt-cli.ts`
		//     +15: the snapshot loader enforces what §8 FIXES rather than what a
		//     step happens to read.
		//   · round 7 (this one, +39) — `receipt-cli.ts` only, both findings CLI
		//     INPUT handling, the verification-soundness classes being closed:
		//     `--trust -` now goes through the one stdin-aware reader (it called
		//     `io.readFile("-")`, so a piped snapshot came back UNVERIFIABLE —
		//     a false statement about material that was supplied), and `-` in
		//     BOTH slots is refused at parse time as a usage error, because one
		//     unframed stream cannot carry two JSON documents. Most of the count
		//     is the two comments recording why, plus the usage line.
		// Post-round total: 8604. 8700 leaves 96 lines of headroom; the NEXT
		// round raises the ceiling rather than trimming a Tier-0 comment to fit.
		//
		// Rounds 8–9 are that next round, and the ceiling is raised to 8900 as
		// promised — no Tier-0 comment was trimmed to fit under 8700. (a)
		// re-verified: assertions 4 and 5 above still pass, `dependencies` is
		// still `{}`, no file was vendored, no mirrored file was edited. (b) what
		// was added, again all of it closing Tier-0 findings on rules that were
		// already there:
		//   · round 8 (c0ef624, +26) — `receipt-verify.ts` only: §8's
		//     `activationSequence` is ONE number governing TWO keys and only the
		//     predecessor's half was enforced, so a key rotated IN at segment 18
		//     authenticated material from segment 11.
		//   · round 9 (this one, +118) — `receipt-verify.ts` +101, `receipt-cli.ts`
		//     +17, four findings, two of them a defect CLASS this budget keeps
		//     paying for: a rule enforced at the wrong LAYER reports the wrong
		//     VERDICT CLASS.
		//       — round 8's own regression: a REVOKED predecessor legitimately
		//         carries no boundary, so failing closed at use time returned
		//         SIG_INVALID for a snapshot that was merely incomplete. Moved to
		//         the loader as UNVERIFIABLE.
		//       — the frozen numeric rules now reach the snapshot members §8
		//         DECLARES as integers (and only those): `18.000000000000001`
		//         rounds to `18` in `JSON.parse` and authorized a key window the
		//         document never carried.
		//       — a refused snapshot reports the version and predecessor it
		//         declared (R-OUT-1), and step 3(a) is rendered beside the named
		//         checks rather than inside them.
		//     Most of the count is prose: three of the four are cases nobody
		//     enumerated rather than rules nobody could derive, and the comments
		//     are what stop the fourth from being a tenth review round.
		// Post-round total: 8748. 8900 leaves 152 lines of headroom.
		//
		// Round 10 raises 8900 → 9200 (+287 used, 165 left). (a) re-verified:
		// assertions 4 and 5 above still pass, `dependencies` is still `{}`, no
		// file was vendored, no mirrored file was edited. (b) what was added:
		// `receipt-verify.ts` +268 and `receipt-cli.ts` +19, all of it ONE change
		// — the frozen-numeric rule stopped being a per-document switch and became
		// a POLICY keyed by declared-field identity.
		//
		// This is the fourth round to pay for the same defect class, and the
		// spend is deliberately front-loaded so there is no fifth. The class: a
		// fractional literal that `JSON.parse` rounds to a legal integer passes
		// every check, because the check reads the value the parser invented
		// rather than the literal that was signed. Rounds at gate 1, gate 8 and
		// gate 9 each fixed it in the one document where it surfaced. What went
		// in this time is the ENUMERATION rather than a fourth instance:
		//   · one `NumericPolicy` tree, descended in lockstep with the document,
		//     replacing a whole-document boolean AND a path REGEX (the regex was
		//     itself a defect — an unknown member named `keys[0]` aliased the real
		//     declared path and was wrongly refused, breaking §4's forward-compat
		//     promise);
		//   · the enumeration is machine-checked three ways, which is the actual
		//     product of this round: `tsc` fails on a new `number` member of
		//     `TrustKey`/`TrustChain` with no policy entry; a coverage oracle
		//     derived from the FIELD TABLES fails on a declared integer no policy
		//     reaches; and a parse-site registry fails when any module in
		//     `packages/verify/src` grows a `JSON.parse`/`readStrictJson` without a
		//     written disposition. All three were proven to FAIL before being
		//     trusted to pass.
		// Most of the count is prose again, and for the same reason as round 9:
		// what stops a fifth round is the written enumeration, not the predicate.
		// Post-round total: 9035. 9200 leaves 165 lines of headroom.
		//
		// ── PARALLEL LINEAGE ON MASTER, merged in here. ──────────────────────
		// While this branch went 4200 → 9200 for the receipt verifier, master
		// independently raised 4200 → 4300 → 4320 for its own receipt-hardening
		// work. Those lines are now IN this total, so their record belongs in this
		// trail — a raise history that silently drops a branch's reasons stops
		// being an audit trail. Master's entries, preserved verbatim in substance:
		// receipt verification — no vendored source).
		//
		// Raised again from 4200 for the receipt-hardening work. WHAT WAS ADDED,
		// since answering that is the whole point of this tripwire: `normalizeEvent`
		// in index.ts, which coerces each parsed `events.jsonl` record into a
		// guaranteed shape so the untrusted log cannot turn verification into an
		// uncaught throw; terminal-evidence ranking in the same file; and the
		// anomaly-evidence line in receipt.ts. All hand-written, node-builtins-only,
		// and roughly half of it explanatory comment. NO vendored source — which is
		// the thing this number exists to catch, and the reason the honest response
		// here was to raise it rather than to shave comments to duck it.
		//
		// Raised again from 4300, for two selection defects in the same file. WHAT
		// WAS ADDED: `firstIsSettlement` now tests terminal KIND instead of the
		// presence of `settled`, because `llm_call_failed` carries `settled: false`
		// and a presence test let an appended ambiguity downgrade a FAILURE into
		// "we do not know"; and the anomaly-evidence window is now bounded by the
		// FIRST terminal rather than the selected one, because ambiguity moves the
		// selection later and slid the boundary past an appended detection. Both are
		// forgery vectors, both hand-written, node-builtins-only, no vendored
		// source. I trimmed these comments twice trying to fit under 4300 before
		// noticing this block already says not to do that.
		//
		// 9200 → 9600, merging origin/master into this branch (2026-08-14). NOT new
		// surface from this ship: the merge folded in master's own receipt-hardening
		// work — index.ts +222 and receipt.ts +111 — plus +10 here for a doc-comment
		// correction on `activationSequence`. Recomputed rather than assumed: the
		// post-merge total is 9378, which the 9200 ceiling would have failed. (a) was
		// re-verified directly and both invariants hold — every import in
		// packages/verify/src is still `node:*` or `./`-relative, and `dependencies`
		// is still `{}` — so the thing this tripwire exists to catch did not happen.
		// Raised to fit the work, per this block's own standing instruction; 222
		// lines of headroom rather than shaving master's hardening to duck a number.
		let total = 0;
		for (const file of readdirSync(VERIFY_SRC).filter((f) => f.endsWith(".ts"))) {
			total += readFileSync(join(VERIFY_SRC, file), "utf-8").split("\n").length;
		}
		expect(total).toBeLessThan(9600);
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
