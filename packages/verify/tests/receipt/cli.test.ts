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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
	writeAllSync,
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

	it("treats an OPTION token where a value is required as a MISSING value", () => {
		// `--trust --help` is a typo, and swallowing the option token turns it
		// into a filename: the tool then reports UNVERIFIABLE (exit 2, "the
		// snapshot could not be read") for what is a usage error (exit 3), and
		// `--help` — the one flag whose whole job is to answer immediately —
		// silently does nothing. Same for `--expect-id`, where the swallowed
		// token would become the arrival context.
		for (const argv of [
			["receipt.json", "--trust", "--help"],
			["receipt.json", "--trust", "--json"],
			["receipt.json", "--trust", "-h"],
		]) {
			expect(parseReceiptArgs(argv), argv.join(" ")).toEqual({
				kind: "error",
				message: "--trust requires a value",
			});
		}
		expect(
			parseReceiptArgs(["receipt.json", "--trust", "t.json", "--expect-id", "--json"]),
		).toEqual({ kind: "error", message: "--expect-id requires a value" });
		// A bare `-` is NOT an option token — it is the stdin filename, and the
		// rule must not grow into a general "starts with a dash" ban.
		expect(parseReceiptArgs(["-", "--trust", "t.json"])).toMatchObject({ kind: "ok" });
	});

	it("exits 3, not 2, when a value-flag swallows an option token", () => {
		// The end-to-end half: the usage error must reach the exit code, since
		// that is the CI contract the split exists for.
		const result = runReceiptCli(["receipt.json", "--trust", "--help"], ioFor(mint()));
		expect(result.exitCode).toBe(3);
		expect(result.stderr).toContain("--trust requires a value");
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

	// ── R4 is not conditional on the receipt being valid ──────────────────────
	//
	// The agreement check was gated on `readReceiptDocument` succeeding, so a
	// resolver holding bytes that PARSE but fail the receipt schema could tamper
	// with its own framing for free: the run reported SCHEMA_INVALID — a
	// statement about the RECEIPT — and the envelope's lie about which receipt
	// this is was never mentioned. §3 is explicit that a mismatch "is an
	// ENVELOPE integrity failure, not SCHEMA_INVALID". R4's inputs are the
	// decoded bytes and the framing; neither needs the bytes to be a valid ut1
	// document, and the one thing the gate really requires is that the bytes are
	// JSON at all (below which step 1 owns the report).
	describe("R4 agreement is not gated on the receipt schema", () => {
		/** Valid JSON, and not a valid receipt: an unknown top-level member. */
		const schemaInvalidBytes = {
			receiptAfterSign: (r: Record<string, unknown>) => ({
				...r,
				note: "unknown to §5",
			}),
		};

		it("reports the ENVELOPE failure when the id is altered and the bytes are schema-invalid", () => {
			const bundle = mint({
				...schemaInvalidBytes,
				envelope: (e) => ({ ...e, receiptId: ALT_RECEIPT_ID }),
			});
			const report = jsonReport(
				runReceiptCli(
					["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
					ioFor(bundle),
				),
			);
			expect(report.verdict).toBe("FAILED");
			expect(report.failure?.step).toBe("envelope");
			expect(report.failure?.code).toBe("ENVELOPE_INVALID");
			expect(report.failure?.detail).toContain("envelope-id↔receipt-id");
		});

		it("reports the ENVELOPE failure when the convenience copy is OMITTED", () => {
			const bundle = mint({
				...schemaInvalidBytes,
				envelope: (e) => {
					const { receipt: _dropped, ...rest } = e;
					return rest;
				},
			});
			const report = jsonReport(
				runReceiptCli(
					["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
					ioFor(bundle),
				),
			);
			expect(report.failure?.step).toBe("envelope");
			expect(report.failure?.detail).toContain("bytes↔copy");
		});

		it("reports the ENVELOPE failure when the copy is ALTERED", () => {
			const bundle = mint({
				...schemaInvalidBytes,
				envelope: (e) => ({
					...e,
					receipt: { ...(e.receipt as Record<string, unknown>), scope: "tampered" },
				}),
			});
			expect(
				jsonReport(
					runReceiptCli(
						["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
						ioFor(bundle),
					),
				).failure?.step,
			).toBe("envelope");
		});

		it("still lets step 1 own a schema-invalid receipt whose FRAMING is honest", () => {
			// The no-false-positive half: R4 running earlier must not turn every
			// bad receipt into an envelope failure. Here the framing agrees with
			// the bytes exactly, so the only defect is the receipt's.
			const report = jsonReport(
				runReceiptCli(
					["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
					ioFor(mint(schemaInvalidBytes)),
				),
			);
			expect(report.verdict).toBe("FAILED");
			expect(report.failure?.step).toBe("schema");
			expect(report.failure?.code).toBe("SCHEMA_INVALID");
		});

		it("still leaves UNPARSEABLE bytes to step 1 — R4 has nothing to compare", () => {
			const bundle = mint({
				bytes: (b) => Buffer.concat([b, Buffer.from("!", "utf8")]),
				envelope: (e) => ({ ...e, receiptId: ALT_RECEIPT_ID }),
			});
			const report = jsonReport(
				runReceiptCli(
					["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
					ioFor(bundle),
				),
			);
			expect(report.verdict).toBe("UNVERIFIABLE");
			expect(report.missing?.what).toBe("receiptBytes");
		});

		it("still verifies the clean envelope", () => {
			const result = runReceiptCli(
				["envelope.json", "--trust", "trust.json", "--envelope"],
				ioFor(mint()),
			);
			expect(result.exitCode).toBe(0);
		});
	});

	it("a receipt-bearing status with receiptBytes absent is UNVERIFIABLE (exit 2), not a usage error (exit 3) — fixer finding 2", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, receiptBytes: undefined }) });
		const outcome = resolveEnvelope(Buffer.from(JSON.stringify(bundle.envelope), "utf8"));
		expect(outcome.kind).toBe("missing");
		if (outcome.kind === "missing") {
			// The diagnostic must not claim the status is non-receipt-bearing —
			// it IS receipt-bearing; the defect is the absent bytes.
			expect(outcome.detail).toContain("receipt-bearing");
			expect(outcome.detail).toContain("receiptBytes");
		}

		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
			ioFor(bundle),
		);
		expect(result.exitCode).toBe(2);
		const report = jsonReport(result);
		expect(report.verdict).toBe("UNVERIFIABLE");
		expect(report.missing?.what).toBe("receiptBytes");
	});

	it("a non-string receiptBytes on a receipt-bearing status is UNVERIFIABLE too, not swallowed into the same branch as a wrong-mode status", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, receiptBytes: 12345 as unknown as string }) });
		const outcome = resolveEnvelope(Buffer.from(JSON.stringify(bundle.envelope), "utf8"));
		expect(outcome.kind).toBe("missing");
	});

	it("a hostile non-finite number in the envelope's `receipt` convenience copy is a verdict, never an uncaught exception — fixer finding 1", () => {
		const bundle = mint();
		const rawEnvelope = JSON.stringify(bundle.envelope);
		// `1e999` is syntactically a valid JSON number token that overflows to
		// `Infinity` on parse — the exact vector `canonical.ts` throws on and
		// `readStrictJson` (envelope-level parse) never rejects, because only
		// the RECEIPT's strict reader runs the frozen numeric rules, never the
		// envelope's `receipt` convenience copy.
		const hostileEnvelope = rawEnvelope.replace('"receipt":{', '"receipt":{"hostile":1e999,');
		expect(hostileEnvelope).not.toBe(rawEnvelope); // the splice actually landed

		const outcome = resolveEnvelope(Buffer.from(hostileEnvelope, "utf8"));
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.code).toBe("ENVELOPE_INVALID");
			expect(outcome.detail).toContain("bytes↔copy");
		}

		// End to end through the public entry point too — must return a
		// `ReceiptCliResult`, never throw, and never manufacture a verdict via
		// exit code 1 from an uncaught exception reaching `cli.ts`'s top level.
		const io = memoryIo({
			"trust.json": bundle.snapshotBytes,
			"envelope.json": Buffer.from(hostileEnvelope, "utf8"),
		});
		let result: ReturnType<typeof runReceiptCli> | undefined;
		expect(() => {
			result = runReceiptCli(
				["envelope.json", "--trust", "trust.json", "--envelope", "--json"],
				io,
			);
		}).not.toThrow();
		expect(result?.exitCode).toBe(1);
		const report = jsonReport(result as { stdout: string });
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("envelope");
	});

	it("a copy that differs from the bytes ONLY by `-0` is still a disagreement", () => {
		// R4 compares the strict-parsed BYTES against the convenience copy, and a
		// canonical-string comparison cannot express this: §13's serializer
		// renders `-0` as `0` (as does `JSON.stringify`), so the two documents
		// canonicalize identically and the check reports agreement about two
		// objects that are not the same object. `Object.is` is the only
		// separator, and the copy is what a consumer reads — the whole reason R4
		// exists is that the resolver can make the two disagree.
		const bundle = mint({
			projection: (p) => {
				(p.spend as Record<string, unknown>).roundingAdjustment = 0;
				return p;
			},
		});
		const raw = JSON.stringify(bundle.envelope);
		// Text surgery, not an object patch: `JSON.stringify` would erase the
		// sign on the way out, so only the wire form can carry this vector.
		const tampered = raw.replace('"roundingAdjustment":0', '"roundingAdjustment":-0');
		expect(tampered).not.toBe(raw);

		const outcome = resolveEnvelope(Buffer.from(tampered, "utf8"));
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.code).toBe("ENVELOPE_INVALID");
			expect(outcome.detail).toContain("bytes↔copy");
		}

		const io = memoryIo({
			"trust.json": bundle.snapshotBytes,
			"envelope.json": Buffer.from(tampered, "utf8"),
		});
		const report = jsonReport(
			runReceiptCli(["envelope.json", "--trust", "trust.json", "--envelope", "--json"], io),
		);
		expect(report.verdict).toBe("FAILED");
		expect(report.failure?.step).toBe("envelope");
	});

	it("still accepts a copy whose KEY ORDER differs — order is not a disagreement", () => {
		// The other direction, and the reason R4 was structural in the first
		// place: the resolver may serialize its convenience copy in any order.
		// Tightening the comparison must not turn that into an integrity failure.
		const bundle = mint();
		const copy = JSON.parse(bundle.receiptBytes.toString("utf8")) as Record<string, unknown>;
		const reordered = Object.fromEntries(Object.entries(copy).reverse());
		const io = memoryIo({
			"trust.json": bundle.snapshotBytes,
			"envelope.json": Buffer.from(
				JSON.stringify({ ...bundle.envelope, receipt: reordered }),
				"utf8",
			),
		});
		const result = runReceiptCli(["envelope.json", "--trust", "trust.json", "--envelope"], io);
		expect(result.exitCode).toBe(0);
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

	it("reports `unavailable` when the check was requested but the run never got there", () => {
		// §7's `notApplicable` means the input "does not exist in this context and
		// never could". Here it exists — the operator typed it — and the run died
		// before step 3, in this case before step 1: the trust file is missing, so
		// nothing was compared. Reporting `notApplicable` would tell the operator
		// their `--expect-id` could not have applied to this document, which is
		// false, and is the same misstatement §7 rules out for a check a verifier
		// declined to run.
		const bundle = mint();
		const io = ioFor(bundle);
		const report = jsonReport(
			runReceiptCli(
				["receipt.json", "--trust", "absent.json", "--expect-id", DEFAULT_RECEIPT_ID, "--json"],
				{
					...io,
					readFile: (path: string) => {
						if (path === "absent.json") throw new Error("ENOENT: no such file");
						return io.readFile(path);
					},
				},
			),
		);
		expect(report.verdict).toBe("UNVERIFIABLE");
		expect(report.arrivalContext).toEqual({
			result: "unavailable",
			expected: DEFAULT_RECEIPT_ID,
		});
	});

	it("reports `unavailable` when a base step failed before step 3(a) ran", () => {
		const bundle = mint({ projection: (p) => ({ ...p, startedAt: "not-a-date" }) });
		const report = jsonReport(
			runReceiptCli(
				["receipt.json", "--trust", "trust.json", "--expect-id", DEFAULT_RECEIPT_ID, "--json"],
				ioFor(bundle),
			),
		);
		expect(report.failure?.step).toBe("schema");
		expect(report.arrivalContext.result).toBe("unavailable");
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
// receipt-spec §7: every named check reported by name, including a
// `notApplicable` result — fixer finding 3 — and CLI spec §6's requirement
// that the human report carry the step ledger and named checks on EVERY
// verdict, not only on a pass — fixer finding 4.
// ─────────────────────────────────────────────────────────────────────────────

describe("human report — the four named checks, on every verdict", () => {
	it("a clean pass names all four §7 checks, including predecessorLinkage and anchorEvidence", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).toContain("Arrival check (3a):");
		expect(result.stdout).toContain("Registry binding (3b):");
		expect(result.stdout).toContain("Predecessor linkage: notApplicable");
		expect(result.stdout).toContain("Checkpoint history:");
		expect(result.stdout).toContain("Anchor evidence: notApplicable");
	});

	it("anchorEvidence is omitted from the checks lines when evidence was SUPPLIED — reported only via UNIMPLEMENTED, never a fabricated §7 value", () => {
		const bundle = mint({ envelope: (e) => ({ ...e, anchorEvidence: { kind: "RekorReceipt" } }) });
		const result = runReceiptCli(
			["envelope.json", "--trust", "trust.json", "--envelope"],
			ioFor(bundle),
		);
		expect(result.stdout).not.toContain("Anchor evidence:");
		expect(result.stdout).toContain("UNIMPLEMENTED: anchorEvidence");
	});

	it("UNVERIFIABLE still carries the step ledger and the named checks — the early return used to discard both", () => {
		const bundle = mint({
			receiptBeforeSign: (r) => {
				const { proof: _dropped, ...rest } = r;
				return rest;
			},
		});
		const result = runReceiptCli(["receipt.json", "--trust", "trust.json"], ioFor(bundle));
		expect(result.stdout).toContain("Verdict: UNVERIFIABLE");
		expect(result.stdout).toContain("Missing required material: proof");
		// The ledger and the 3(a)/3(b) disclosure CLI spec §6 calls out by
		// name — exactly what an auditor needs on the run that got furthest
		// before stopping.
		expect(result.stdout).toContain("Steps:");
		expect(result.stdout).toContain("Arrival check (3a):");
		expect(result.stdout).toContain("Registry binding (3b):");
		expect(result.stdout).toContain("Predecessor linkage:");
	});

	it("a true pre-run refusal (e.g. an unreadable --trust file) still renders no steps/checks section — nothing to fabricate", () => {
		const bundle = mint();
		const result = runReceiptCli(["receipt.json", "--trust", "does-not-exist.json"], ioFor(bundle));
		expect(result.stdout).toContain("Verdict: UNVERIFIABLE");
		expect(result.stdout).not.toContain("Steps:");
		expect(result.stdout).not.toContain("Arrival check (3a):");
	});

	// ── A failed CHECK carries its detail into the human report ───────────────
	//
	// Step 9 is upgrade-only: a broken history never demotes the base verdict,
	// so `report.failure` stays null and the `Failed step:` block — the one
	// place the human report ever printed a detail — does not render. The reader
	// was left with `Checkpoint history: failed` and, in the ledger,
	// `extensions failed (HISTORY_INVALID)`. That does not distinguish a short
	// history from a broken lineage edge from a checkpoint signed by the wrong
	// key, and CLI spec §6 does not make `--json` the only honest mode.
	describe("a failed extension check prints WHY, not just that it failed", () => {
		const HISTORY_CASES: ReadonlyArray<readonly [string, Parameters<typeof mint>[0], string]> = [
			[
				"a broken lineage edge",
				{
					checkpointsUnsigned: (checkpoints) =>
						checkpoints.map((c, i) =>
							i === 1 ? { ...c, previousSegmentRoot: "b".repeat(64) } : c,
						),
				},
				"previousSegmentRoot is not the preceding checkpoint's root",
			],
			[
				"a history short of the registered genesis",
				{ history: (h) => h.slice(1) },
				"the registered genesis",
			],
			["an empty history", { history: () => [] }, "empty"],
		];

		for (const [label, options, needle] of HISTORY_CASES) {
			it(`names ${label} in the human report`, () => {
				const bundle = mint(options);
				const result = runReceiptCli(
					["envelope.json", "--trust", "trust.json", "--envelope"],
					ioFor(bundle),
				);
				// The base verdict is untouched — this is the upgrade-only rule, and
				// it is exactly why the detail had nowhere else to go.
				expect(result.stdout).toContain("Verdict: VERIFIED_CHECKPOINT");
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain("Checkpoint history: failed");
				expect(result.stdout).toContain("HISTORY_INVALID");
				expect(result.stdout, label).toContain(needle);
			});
		}

		it("adds nothing to a check that passed or was notApplicable", () => {
			const result = runReceiptCli(
				["envelope.json", "--trust", "trust.json", "--envelope"],
				ioFor(mint()),
			);
			expect(result.stdout).toContain("Checkpoint history: passed");
			expect(result.stdout).toContain("Predecessor linkage: notApplicable");
			expect(result.stdout).not.toContain("HISTORY_INVALID");
		});
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

it("--help prints the receipt-mode usage and exits 3 (never 0 — no verdict was reached, and 0 is reserved for VERIFIED_CHECKPOINT or higher)", () => {
	const result = runReceiptCli(["--help"], memoryIo({}));
	expect(result.exitCode).toBe(3);
	expect(result.stdout).toContain(RECEIPT_USAGE);
});

it("--help recognized at any argv position does not leak exit 0 (an unsanitized <file> of literally '--help' must not read as verified)", () => {
	const result = runReceiptCli(["r.json", "--trust", "t.json", "--help"], memoryIo({}));
	expect(result.exitCode).toBe(3);
	expect(result.stdout).toContain(RECEIPT_USAGE);
});

// ─────────────────────────────────────────────────────────────────────────────
// `cli.ts` dispatch (CLI spec §2) — everything above exercises `receipt-cli.ts`
// directly, which says nothing about whether `cli.ts` ever routes argv into
// it. These spawn the REAL built entry point (`npx tsx cli.ts …`, the same
// pattern `anchor-bundle-terminal-injection.test.ts` uses for core's CLI) so a
// broken, moved, or loosened dispatch check actually fails a test instead of
// only a string-constant comparison.
// ─────────────────────────────────────────────────────────────────────────────

describe("cli.ts dispatch", () => {
	const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
	const cli = join(repoRoot, "packages", "verify", "src", "cli.ts");
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("writeAllSync hands every byte to the OS before it returns", () => {
		// `process.exit()` terminates the process without draining an
		// unflushed stream, and on a POSIX PIPE — which is exactly what
		// `usertrust-verify … --json | jq` creates — `process.stdout.write` is
		// asynchronous. A report can therefore be truncated mid-JSON while the
		// exit code says 0, which is the worst possible pairing: a consumer that
		// checks the code gets a parse error, and one that does not gets half a
		// verdict. Writing to the fd SYNCHRONOUSLY is what makes the subsequent
		// exit safe, and a partial write (short count, or EAGAIN on a
		// non-blocking pipe) has to be resumed, not dropped.
		const dir = mkdtempSync(join(tmpdir(), "receipt-cli-flush-"));
		dirs.push(dir);
		const path = join(dir, "out.txt");
		// Larger than any pipe buffer, so a single `write(2)` cannot satisfy it.
		const payload = `${"verdict ".repeat(200_000)}\n`;
		const fd = openSync(path, "w");
		try {
			writeAllSync(fd, payload);
			writeAllSync(fd, ""); // a no-op, not a zero-length write
		} finally {
			closeSync(fd);
		}
		expect(readFileSync(path, "utf-8")).toBe(payload);
	});

	it("--json survives a PIPE intact: whole object on stdout, exit code preserved", () => {
		// The `| jq` contract, end to end through the real entry point with
		// stdout as a pipe (spawnSync always gives it one).
		const { receipt, trust } = tmpBundle();
		const res = spawnSync("npx", ["tsx", cli, "receipt", receipt, "--trust", trust, "--json"], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		expect(res.status).toBe(0);
		const report = JSON.parse(res.stdout) as ReceiptCliReport;
		expect(report.verdict).toBe("VERIFIED_CHECKPOINT");
		expect(report.reportVersion).toBe(1);
		// stdout carries the JSON and NOTHING else (CLI spec §6).
		expect(res.stdout.trimEnd().endsWith("}")).toBe(true);
	}, 30_000);

	function tmpBundle(): { dir: string; receipt: string; trust: string } {
		const dir = mkdtempSync(join(tmpdir(), "receipt-cli-dispatch-"));
		dirs.push(dir);
		const bundle = mint();
		const receipt = join(dir, "receipt.json");
		const trust = join(dir, "trust.json");
		writeFileSync(receipt, bundle.receiptBytes);
		writeFileSync(trust, bundle.snapshotBytes);
		return { dir, receipt, trust };
	}

	it("`receipt` as argv[0] reaches receipt mode end to end (hazard a: a receipt flag must not fall through to the vault parser's usage(), exit 1)", () => {
		const { receipt, trust } = tmpBundle();
		const res = spawnSync("npx", ["tsx", cli, "receipt", receipt, "--trust", trust], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		// If the dispatch guard were absent, moved, or bypassed, `--trust`
		// would be unknown to the vault flag loop and hit the SHARED usage(),
		// which exits 1 and prints vault's own `--anchor-url` help text — the
		// wrong code (FAILED) for a well-formed receipt-mode invocation.
		expect(res.status).toBe(0);
		expect(res.stdout).toContain("Verdict: VERIFIED_CHECKPOINT");
		expect(res.stdout).not.toContain("--anchor-url");
	}, 30_000);

	it("`receipt` with no <file> gets receipt mode's OWN usage (exit 3), not the vault parser's (exit 1)", () => {
		const res = spawnSync("npx", ["tsx", cli, "receipt"], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		expect(res.status).toBe(3);
		expect(res.stderr).toContain("missing <file>");
		// Vault's shared usage() text — must NOT appear; its presence would
		// mean the vault parser ran instead of receipt mode's own handler.
		expect(res.stderr).not.toContain("--anchor-url");
		expect(res.stdout).toBe("");
	}, 30_000);

	it("the dispatch token is argv[2] EXACTLY — the literal string 'receipt' appearing elsewhere in argv must not trigger receipt mode (hazard b's mirror: a real vault invocation must not be hijacked)", () => {
		// argv[2] is "does-not-exist" here, not "receipt" — "receipt" only
		// appears as a FLAG VALUE. A dispatch check loosened to
		// `argv.includes("receipt")` would wrongly enter receipt mode; the
		// correct `argv[2] === "receipt"` check leaves this a vault-mode
		// invocation, and `--trust` (unknown to the vault parser) hits the
		// shared usage(), exit 1.
		const res = spawnSync("npx", ["tsx", cli, "does-not-exist", "--trust", "receipt"], {
			cwd: repoRoot,
			encoding: "utf-8",
		});
		expect(res.status).toBe(1);
		expect(res.stdout).toContain("--anchor-url");
	}, 30_000);
});
