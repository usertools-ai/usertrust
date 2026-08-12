// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Task 5 — the CLI surface (CLI spec §2, §6): argument parsing, dispatch,
 * exit codes, `--envelope`'s R4 agreement check, `--json`/human reports, and
 * terminal safety.
 *
 * Runs `runReceiptCli` directly against an in-memory `ReceiptCliIo` rather
 * than spawning the built CLI — the same "pure function, no process" pattern
 * the rest of this package's tests use (`verifyTransaction`,
 * `verifyVaultWithAnchors`, …), and the one this module's own header commits
 * to: every path through `receipt-cli.ts` is I/O-injected precisely so it is
 * testable without a build step or a subprocess.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	ARTIFACT_VACUUM_CAVEAT,
	CHECKPOINT_RUNG_DISCLAIMER,
	ESTIMATES_CAVEAT,
	HISTORY_EQUIVOCATION_CAVEAT,
	parseReceiptArgs,
	RECEIPT_DISPATCH_TOKEN,
	RECEIPT_USAGE,
	type ReceiptCliIo,
	type ReceiptCliReport,
	resolveEnvelope,
	runReceiptCli,
	SUPERSESSION_CAVEAT,
} from "../../src/receipt-cli.js";
import {
	ALT_RECEIPT_ID,
	corruptBase64,
	DEFAULT_RECEIPT_ID,
	keyFromSeed,
	type MintedBundle,
	mint,
} from "./harness.js";

// ─────────────────────────────────────────────────────────────────────────────
// In-memory IO.
// ─────────────────────────────────────────────────────────────────────────────

function memoryIo(files: Readonly<Record<string, Buffer>>, stdin?: Buffer): ReceiptCliIo {
	return {
		readFile: (path: string) => {
			const buf = files[path];
			if (buf === undefined) {
				const err = new Error(`ENOENT: no such file, open '${path}'`) as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return buf;
		},
		readStdin: () => {
			if (stdin === undefined) throw new Error("no stdin available");
			return stdin;
		},
	};
}

function ioFor(bundle: MintedBundle, extra: Readonly<Record<string, Buffer>> = {}): ReceiptCliIo {
	return memoryIo({
		"receipt.json": bundle.receiptBytes,
		"trust.json": bundle.snapshotBytes,
		"envelope.json": Buffer.from(JSON.stringify(bundle.envelope), "utf8"),
		...extra,
	});
}

function jsonReport(result: { stdout: string }): ReceiptCliReport {
	return JSON.parse(result.stdout) as ReceiptCliReport;
}

// ─────────────────────────────────────────────────────────────────────────────
// parseReceiptArgs.
// ─────────────────────────────────────────────────────────────────────────────

describe("parseReceiptArgs", () => {
	it("accepts the minimal required form", () => {
		const parsed = parseReceiptArgs(["receipt.json", "--trust", "trust.json"]);
		expect(parsed).toEqual({
			kind: "ok",
			args: {
				file: "receipt.json",
				trust: "trust.json",
				envelope: false,
				expectId: undefined,
				json: false,
			},
		});
	});

	it("parses --envelope, --expect-id and --json together", () => {
		const parsed = parseReceiptArgs([
			"env.json",
			"--trust",
			"trust.json",
			"--envelope",
			"--expect-id",
			DEFAULT_RECEIPT_ID,
			"--json",
		]);
		expect(parsed).toEqual({
			kind: "ok",
			args: {
				file: "env.json",
				trust: "trust.json",
				envelope: true,
				expectId: DEFAULT_RECEIPT_ID,
				json: true,
			},
		});
	});

	it("rejects a missing <file> positional", () => {
		expect(parseReceiptArgs(["--trust", "trust.json"])).toEqual({
			kind: "error",
			message: "missing <file>",
		});
	});

	it("rejects a missing --trust FLAG distinctly from a missing --trust FILE", () => {
		// CLI spec §6: "no condition maps to two codes" — the flag's absence is
		// a usage error; the file's absence (exercised in the exit-code suite
		// below) is missing material. Two different codes, so they must stay
		// two different code PATHS here too.
		expect(parseReceiptArgs(["receipt.json"])).toEqual({
			kind: "error",
			message: "missing required --trust <snapshot.json>",
		});
	});

	it("rejects an unknown flag", () => {
		const parsed = parseReceiptArgs(["receipt.json", "--trust", "trust.json", "--bogus"]);
		expect(parsed).toEqual({ kind: "error", message: 'unknown flag "--bogus"' });
	});

	it("rejects a second positional", () => {
		const parsed = parseReceiptArgs(["a.json", "b.json", "--trust", "trust.json"]);
		expect(parsed.kind).toBe("error");
	});

	it("rejects a value-flag with nothing after it", () => {
		expect(parseReceiptArgs(["receipt.json", "--trust"])).toEqual({
			kind: "error",
			message: "--trust requires a value",
		});
	});

	it("recognizes --help / -h", () => {
		expect(parseReceiptArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseReceiptArgs(["-h"])).toEqual({ kind: "help" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Dispatch token — the literal `cli.ts` compares `argv[0]` against EXACTLY.
// ─────────────────────────────────────────────────────────────────────────────

it("the dispatch token is the literal argv[0] receipt mode owns", () => {
	expect(RECEIPT_DISPATCH_TOKEN).toBe("receipt");
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit codes (CLI spec §6) — one representative condition per row, and the
// "no condition maps to two codes" split for both --trust and <file>.
// ─────────────────────────────────────────────────────────────────────────────

describe("exit codes", () => {
	it("0: a clean receipt with no --envelope reaches VERIFIED_CHECKPOINT", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Verdict: VERIFIED_CHECKPOINT");
	});

	it("0: --envelope with a complete history reaches VERIFIED_CHECKPOINT_HISTORY", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Verdict: VERIFIED_CHECKPOINT_HISTORY");
	});

	it("1: a tampered mint signature is FAILED, not UNVERIFIABLE", () => {
		const bundle = mint({
			receiptAfterSign: (r) => ({
				...r,
				signature: {
					...(r.signature as Record<string, unknown>),
					sig: corruptBase64((r.signature as Record<string, string>).sig),
				},
			}),
		});
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("Verdict: FAILED");
		expect(result.stdout).toContain("SIG_INVALID");
	});

	it("2: an absent --trust FILE is UNVERIFIABLE (missing trustSnapshot), not a usage error", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "does-not-exist.json"], ioFor(bundle));
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("Verdict: UNVERIFIABLE");
		expect(result.stdout).toContain("trustSnapshot");
	});

	it("3: a missing --trust FLAG is a usage error, exit 3", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json"], ioFor(bundle));
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("--trust");
		expect(result.stdout).toBe("");
	});

	it("2: an absent <file> is UNVERIFIABLE (missing receiptBytes)", () => {
		const bundle = mint();
		const result = runReceiptCli(["does-not-exist.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain("receiptBytes");
	});

	it("3: no <file> positional at all is a usage error, exit 3", () => {
		const bundle = mint();
		const result = runReceiptCli(["--trust", "trust.json"], ioFor(bundle));
		expect(result.exitCode).toBe(3);
	});

	it("2: a structurally invalid trust snapshot is UNVERIFIABLE", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json"],
			ioFor(bundle, { "trust.json": Buffer.from("{not json", "utf8") }),
		);
		expect(result.exitCode).toBe(2);
	});

	it("3: an unknown flag is a usage error naming it, not the shared usage() exit 1", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--nope"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("--nope");
	});

	it("`-` reads the receipt from stdin", () => {
		const bundle = mint();
		const io = memoryIo({ "trust.json": bundle.snapshotBytes }, bundle.receiptBytes);
		const result = runReceiptCli(["-", "--trust", "trust.json"], io);
		expect(result.exitCode).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// --envelope: R4 agreement, apiVersion/status protocol checks.
// ─────────────────────────────────────────────────────────────────────────────

describe("--envelope", () => {
	it("a bytes↔copy disagreement is FAILED with step envelope, not SCHEMA_INVALID", () => {
		const bundle = mint({
			envelope: (e) => ({
				...e,
				receipt: { ...(e.receipt as Record<string, unknown>), scope: "tampered" },
			}),
		});
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(1);
		const report = JSON.parse(
			runReceiptCli(
				["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
				ioFor(bundle),
			).stdout,
		) as ReceiptCliReport;
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("envelope");
		expect(report.failure?.code).toBe("ENVELOPE_INVALID");
		expect(report.failure?.detail).not.toContain("SCHEMA_INVALID");
	});

	it("an envelope-id ↔ receipt-id disagreement is FAILED, step envelope", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, receiptId: ALT_RECEIPT_ID }) });
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
			ioFor(bundle),
		);
		const report = jsonReport(result);
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("envelope");
	});

	it("an unsupported apiVersion is a PROTOCOL error — FAILED, not UNVERIFIABLE", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, apiVersion: "2" }) });
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
			ioFor(bundle),
		);
		const report = jsonReport(result);
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("envelope");
	});

	it("a non-receipt-bearing status exits 3 — wrong document, wrong mode", () => {
		const bundle = mint({
			envelope: (e) => ({ ...e, status: "reserved", receiptBytes: undefined }),
		});
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("reserved");
	});

	it("resolveEnvelope surfaces missing receiptBytes as `missing`, not a throw", () => {
		const outcome = resolveEnvelope(Buffer.from("not json", "utf8"));
		expect(outcome.kind).toBe("missing");
	});

	it("anchorEvidence PRESENT is reported OUT OF BAND — omitted from checks, named in unimplemented, never a §7 value", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, anchorEvidence: { kind: "RekorReceipt" } }) });
		const report = jsonReport(
			runReceiptCli(
				["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
				ioFor(bundle),
			),
		);
		expect(report.unimplemented).toEqual(["anchorEvidence"]);
		expect(report.checks?.anchorEvidence).toBeUndefined();
		// The rung stays capped below verified_anchored — history alone.
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT_HISTORY");

		const human = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		).stdout;
		expect(human).toContain("UNIMPLEMENTED: anchorEvidence");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// --expect-id (step 3(a)).
// ─────────────────────────────────────────────────────────────────────────────

describe("--expect-id", () => {
	it("a matching arrival id passes step 3(a)", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--expect-id", DEFAULT_RECEIPT_ID, "--json"],
			ioFor(bundle),
		);
		const report = jsonReport(result);
		expect(report.arrivalContext.result).toBe("passed");
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
	});

	it("a mismatched arrival id FAILS with ID_MISMATCH", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--expect-id", ALT_RECEIPT_ID, "--json"],
			ioFor(bundle),
		);
		const report = jsonReport(result);
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.code).toBe("ID_MISMATCH");
	});

	it("an unparseable --expect-id is a USAGE error, not a silently-skipped check", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--expect-id", "not-an-id-or-url"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(3);
	});

	it("omitting --expect-id makes 3(a) notApplicable, not a pass", () => {
		const bundle = mint();
		const report = jsonReport(
			runReceiptCli(["receipt.json", "--trust", "trust.json", "--json"], ioFor(bundle)),
		);
		expect(report.arrivalContext.result).toBe("notApplicable");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// --json: stdout carries ONLY the JSON object; diagnostics go to stderr.
// ─────────────────────────────────────────────────────────────────────────────

describe("--json", () => {
	it("stdout is exactly one JSON object and nothing else", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--json"],
			ioFor(bundle),
		);
		expect(() => JSON.parse(result.stdout)).not.toThrow();
		expect(result.stdout.trim().startsWith("{")).toBe(true);
		expect(result.stdout.trim().endsWith("}")).toBe(true);
	});

	it("a usage error's diagnostics go to stderr, and stdout is empty", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--json"], ioFor(bundle));
		expect(result.stdout).toBe("");
		expect(result.stderr.length).toBeGreaterThan(0);
	});

	it("carries reportVersion 1 and the full §6 shape on a verified run", () => {
		const bundle = mint();
		const report = jsonReport(
			runReceiptCli(["receipt.json", "--trust", "trust.json", "--json"], ioFor(bundle)),
		);
		expect(report.reportVersion).toBe(1);
		expect(report.receiptId).toBe(DEFAULT_RECEIPT_ID);
		expect(report.trustSnapshot?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(report.computed.amountUsd).toBe("4.8224");
		expect(report.posture?.delegation).toBe("selfDebitsOnly");
		expect(report.limitations).toEqual([
			"forkDisclaimer",
			"artifactVacuum",
			"supersessionUnknown",
			"delegatedSpendExcluded",
		]);
	});

	it("withholds computed.amountUsd and posture on a FAILED verdict — never a renderable total for a bad receipt", () => {
		const bundle = mint({
			receiptAfterSign: (r) => ({
				...r,
				signature: {
					...(r.signature as Record<string, unknown>),
					sig: corruptBase64((r.signature as Record<string, string>).sig),
				},
			}),
		});
		const report = jsonReport(
			runReceiptCli(["receipt.json", "--trust", "trust.json", "--json"], ioFor(bundle)),
		);
		expect(report.computed.amountUsd).toBeNull();
		expect(report.posture).toBeNull();
		expect(report.limitations).toEqual([]);
	});

	it("UNVERIFIABLE carries no failure step or code, only missing", () => {
		const bundle = mint();
		const report = jsonReport(
			runReceiptCli(["receipt.json", "--trust", "does-not-exist.json", "--json"], ioFor(bundle)),
		);
		expect(report.verdict).toBe("UNVERIFIABLE");
		expect(report.failure).toBeNull();
		expect(report.missing?.what).toBe("trustSnapshot");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Human report — the honesty rules (CLI spec §6): rung disclaimers verbatim,
// the equivocation caveat traveling WITH the history claim, and no green
// language on UNVERIFIABLE.
// ─────────────────────────────────────────────────────────────────────────────

describe("human report honesty rules", () => {
	it("VERIFIED_CHECKPOINT carries the fork disclaimer but NOT the history caveat", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).toContain(CHECKPOINT_RUNG_DISCLAIMER);
		expect(result.stdout).not.toContain(HISTORY_EQUIVOCATION_CAVEAT);
		expect(result.stdout).toContain(SUPERSESSION_CAVEAT);
		expect(result.stdout).toContain(ARTIFACT_VACUUM_CAVEAT);
	});

	it("VERIFIED_CHECKPOINT_HISTORY carries BOTH disclaimers — the caveat travels WITH the history claim (PR #92's defect)", () => {
		const bundle = mint();
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		);
		expect(result.stdout).toContain(CHECKPOINT_RUNG_DISCLAIMER);
		expect(result.stdout).toContain(HISTORY_EQUIVOCATION_CAVEAT);
	});

	it("an estimated usage posture carries the estimates caveat", () => {
		const bundle = mint({
			projection: (p) => ({
				...p,
				spend: { ...(p.spend as Record<string, unknown>), usagePosture: "estimated" },
			}),
		});
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).toContain(ESTIMATES_CAVEAT);
	});

	it("a provider usage posture does NOT carry the estimates caveat", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).not.toContain(ESTIMATES_CAVEAT);
	});

	it("UNVERIFIABLE prints no rung disclaimer and no dollar amount — no green language", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "does-not-exist.json"], ioFor(bundle));
		expect(result.stdout).not.toContain(CHECKPOINT_RUNG_DISCLAIMER);
		expect(result.stdout).not.toContain("Amount: $");
		expect(result.stdout).not.toContain("VERIFIED");
	});

	it("FAILED prints no rung disclaimer and no dollar amount", () => {
		const bundle = mint({
			receiptAfterSign: (r) => ({
				...r,
				signature: {
					...(r.signature as Record<string, unknown>),
					sig: corruptBase64((r.signature as Record<string, string>).sig),
				},
			}),
		});
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).not.toContain(CHECKPOINT_RUNG_DISCLAIMER);
		expect(result.stdout).not.toContain("Amount: $");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal safety (AGENTS.md; CLI spec §6) — HARDEN-style, matching
// `tests/harden/receipt-terminal-injection.test.ts`'s payload and method.
// ─────────────────────────────────────────────────────────────────────────────

describe("terminal safety", () => {
	const ESC = "\x1b";
	const ERASE_LINE = `${ESC}[2K`;
	const CURSOR_UP = `${ESC}[1A`;
	const HOSTILE = `${ERASE_LINE}\r${CURSOR_UP}VERIFIED`;

	function seed(label: string): Buffer {
		return createHash("sha256").update(`receipt-cli-hostile/${label}`).digest();
	}

	it("a hostile keyId in the trust snapshot cannot repaint the printed verdict line", () => {
		const hostileMintKey = keyFromSeed(`utk_mint_${HOSTILE}`, seed("mint"));
		const bundle = mint({
			mintKey: hostileMintKey,
			// REVOKE the hostile-keyId key (structurally valid — a revoked key
			// needs no activationSequence) so step 4's key-state failure is
			// forced to name it (`key ${keyId} is revoked — …`) — the detail
			// string embeds the untrusted keyId verbatim before this module's
			// sanitizer runs. (A wrong-ROLE mutation trips the snapshot's own
			// structural rules first, at UNVERIFIABLE — a real check, just not
			// the one this test wants to exercise.)
			snapshot: (s) => ({
				...s,
				keys: s.keys.map((k) =>
					k.keyId === hostileMintKey.keyId ? { ...k, state: "revoked" as const } : k,
				),
			}),
		});
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));

		expect(result.exitCode).toBe(1);
		expect(result.stdout).not.toContain(ESC);
		expect(result.stdout).not.toContain("\r");
		// The verdict line survives INTACT — a forged "VERIFIED" appended after
		// erase/cursor-up codes never reaches the terminal because the codes
		// themselves never reach the output.
		expect(result.stdout).toContain("Verdict: FAILED");
		expect(result.stdout).not.toMatch(/Verdict: VERIFIED/);
		// Scrubbed, not silently dropped: substitution leaves visible evidence.
		expect(result.stdout).toContain("?");
	});

	it("the same hostile keyId is scrubbed in the --json report's failure.detail too", () => {
		const hostileMintKey = keyFromSeed(`utk_mint_json_${HOSTILE}`, seed("mint-json"));
		const bundle = mint({
			mintKey: hostileMintKey,
			snapshot: (s) => ({
				...s,
				keys: s.keys.map((k) =>
					k.keyId === hostileMintKey.keyId ? { ...k, state: "revoked" as const } : k,
				),
			}),
		});
		const result = runReceiptCli(
			["receipt.json", "--trust", "trust.json", "--json"],
			ioFor(bundle),
		);
		expect(result.stdout).not.toContain(ESC);
		const report = jsonReport(result);
		expect(report.failure?.detail).not.toContain(ESC);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Usage text.
// ─────────────────────────────────────────────────────────────────────────────

it("--help prints the receipt-mode usage and exits 0", () => {
	const result = runReceiptCli(["--help"], memoryIo({}));
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain(RECEIPT_USAGE);
});
