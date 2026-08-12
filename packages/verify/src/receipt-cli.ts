// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust-verify receipt` — CLI spec (v0.3) §2, §6.
 *
 * This module is the whole receipt-mode surface: argument parsing, envelope
 * resolution (§3's byte-authority rule, the R4 agreement check), the
 * `--json` and human reports, and the exit-code mapping. `cli.ts` wires it to
 * real `node:fs`/stdin and calls `process.exit`; every function here is pure
 * and I/O-injected so it can be tested without spawning a process (CLI spec
 * §7: zero deps, `node:*`/`./`-relative only — that discipline extends to
 * the test suite, which stays inside the same package).
 *
 * **A throw is never a verdict here either.** Every path returns a
 * `ReceiptCliResult`; the only exceptions this module lets escape are ones
 * `io.readFile`/`io.readStdin` throw for an unreadable path, and those are
 * caught at the two call sites and turned into UNVERIFIABLE/missing-material
 * results, exactly like every other refusal in `receipt-verify.ts`.
 */

import { writeSync } from "node:fs";
import { forDisplay } from "./receipt.js";
import {
	decodeCanonicalBase64,
	isJsonObject,
	type JsonValue,
	loadTrustSnapshot,
	type ReceiptExtensionMaterial,
	type ReceiptReport,
	type ReceiptVerdict,
	readStrictJson,
	receiptIdFromArrivalContext,
	structurallyEqualJson,
	type TrustSnapshotIdentity,
	verifyReceipt,
} from "./receipt-verify.js";

// ─────────────────────────────────────────────────────────────────────────────
// I/O injection.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptCliIo {
	/** Throws on any failure (ENOENT, EACCES, …) — never returns partial bytes. */
	readonly readFile: (path: string) => Buffer;
	readonly readStdin: () => Buffer;
}

export interface ReceiptCliResult {
	readonly exitCode: 0 | 1 | 2 | 3;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Write every byte of `text` to `fd`, synchronously, before returning.
 *
 * `cli.ts` ends receipt mode with `process.exit(code)`, and that is deliberate:
 * the exit codes ARE the contract (0/1/2/3), and nothing after the dispatch
 * block may run. But `process.exit` terminates without draining an unflushed
 * stream, and `process.stdout` is ASYNCHRONOUS when stdout is a POSIX pipe —
 * which is precisely what `usertrust-verify … --json | jq` creates. The failure
 * is the worst-shaped one available: a truncated report paired with a
 * successful exit code, so a consumer that checks the code gets a JSON parse
 * error and one that does not gets half a verdict.
 *
 * Writing to the fd is what makes the subsequent exit safe. Three cases the
 * loop exists for:
 *
 *  - `write(2)` may accept fewer bytes than offered, so a short count is
 *    RESUMED rather than dropped;
 *  - a non-blocking pipe answers `EAGAIN` when its buffer is full, which means
 *    "not yet", not "no" — retried;
 *  - `EPIPE` means the reader is GONE (`… | head -1`). Stop writing and return:
 *    there is nobody left to tell, the remaining bytes have no destination, and
 *    the alternative — letting it escape into `cli.ts`'s top level — replaces
 *    the verdict's exit code with an uncaught-exception 1, i.e. reports FAILED
 *    for a receipt that verified. The exit code is the contract; a closed
 *    reader must not be able to rewrite it.
 *
 * Any other errno is a real I/O failure and propagates.
 */
export function writeAllSync(fd: number, text: string): void {
	if (text.length === 0) return;
	const bytes = Buffer.from(text, "utf8");
	let offset = 0;
	while (offset < bytes.length) {
		try {
			offset += writeSync(fd, bytes, offset, bytes.length - offset);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EPIPE") return;
			if (code !== "EAGAIN") throw error;
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Terminal safety (AGENTS.md; CLI spec §6). Every untrusted string — keyIds,
// snapshot version/predecessor strings, failure/missing details, receipt
// IDs — is scrubbed BEFORE truncation, using the one sanitizer the repo owns
// (`receipt.ts`'s `forDisplay`, exported for exactly this) rather than a
// third copy.
// ─────────────────────────────────────────────────────────────────────────────

const MAX_UNTRUSTED_FIELD = 240;

function clip(raw: string, max = MAX_UNTRUSTED_FIELD): string {
	const safe = forDisplay(raw);
	return safe.length <= max ? safe : `${safe.slice(0, max)}…`;
}

function clipNullable(raw: string | null): string | null {
	return raw === null ? null : clip(raw);
}

// ─────────────────────────────────────────────────────────────────────────────
// Usage.
// ─────────────────────────────────────────────────────────────────────────────

export const RECEIPT_USAGE = `Usage: usertrust-verify receipt <file> --trust <snapshot.json> [options]

  <file>                 The signed receipt document, or the resolver
                         envelope with --envelope. "-" reads stdin.
  --trust <file>         REQUIRED. The pinned §8 well-known snapshot.
  --envelope             <file> is the resolver's unsigned envelope; the
                         receipt input becomes its receiptBytes member.
  --expect-id <ctx>      Arrival context for step 3(a): a bare ut1_… id, a
                         resolution URL, or a Usertrust-Receipt: trailer line.
  --json                 Machine-readable report on stdout; diagnostics on
                         stderr.

Exit codes: 0 verified, 1 FAILED, 2 UNVERIFIABLE, 3 usage error.`;

type ParsedReceiptArgs = {
	readonly file: string;
	readonly trust: string;
	readonly envelope: boolean;
	readonly expectId: string | undefined;
	readonly json: boolean;
};

type ArgsResult =
	| { readonly kind: "ok"; readonly args: ParsedReceiptArgs }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string };

/**
 * EVERY leading-dash token except bare `-`.
 *
 * The rule is the SHAPE, not the two spellings the parser used to enumerate
 * (`-h` and `--…`). A short flag it does not know — `-x`, `-v`, a mistyped
 * `-trust` — is still a flag, and treating it as a filename is what turned
 * `--trust -x` into UNVERIFIABLE (exit 2, a statement about trust material) and
 * `receipt -x` into UNVERIFIABLE for the receipt, when both are usage errors
 * (exit 3). A bare `-` is deliberately NOT one: it is the stdin filename, in
 * both the positional slot and after `--trust`.
 */
function isOptionToken(token: string): boolean {
	return token.startsWith("-") && token !== "-";
}

/**
 * Receipt mode's OWN parser (CLI spec §2's dispatch rule): every flag here is
 * unknown to the vault parser, so this must never fall through to it, and
 * every refusal below is a USAGE error (exit 3) — never the shared `usage()`,
 * which exits 1 (FAILED, the wrong code for "you typed the command wrong").
 */
export function parseReceiptArgs(argv: readonly string[]): ArgsResult {
	let file: string | undefined;
	let trust: string | undefined;
	let envelope = false;
	let expectId: string | undefined;
	let json = false;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i] as string;
		/**
		 * The value for a value-taking flag, or `undefined` when there is none.
		 *
		 * An OPTION TOKEN is not a value. `--trust --help` is a typo, and
		 * swallowing the token turns it into a filename: the tool then reports
		 * UNVERIFIABLE (exit 2 — "the pinned snapshot could not be read") for
		 * what is a usage error (exit 3), and `--help`, the one flag whose whole
		 * job is to answer immediately, silently does nothing. A bare `-` is
		 * deliberately NOT an option token: it is the stdin filename.
		 */
		const next = (): string | undefined => {
			const candidate = argv[i + 1];
			if (candidate === undefined) return undefined;
			return isOptionToken(candidate) ? undefined : candidate;
		};
		if (arg === "--help" || arg === "-h") return { kind: "help" };
		if (arg === "--trust") {
			const value = next();
			if (value === undefined) return { kind: "error", message: "--trust requires a value" };
			trust = value;
			i += 1;
		} else if (arg === "--envelope") {
			envelope = true;
		} else if (arg === "--expect-id") {
			const value = next();
			if (value === undefined) return { kind: "error", message: "--expect-id requires a value" };
			expectId = value;
			i += 1;
		} else if (arg === "--json") {
			json = true;
		} else if (isOptionToken(arg)) {
			return { kind: "error", message: `unknown flag ${JSON.stringify(arg)}` };
		} else if (file === undefined) {
			file = arg;
		} else {
			return { kind: "error", message: `unexpected extra argument ${JSON.stringify(arg)}` };
		}
	}
	if (file === undefined) return { kind: "error", message: "missing <file>" };
	if (trust === undefined) {
		return { kind: "error", message: "missing required --trust <snapshot.json>" };
	}
	return { kind: "ok", args: { file, trust, envelope, expectId, json } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The CLI report shape (CLI spec §6). Built from `ReceiptReport` plus what
// only the CLI layer knows: the snapshot's identity (R-OUT-1) and the
// pre-verification failures a `ReceiptReport` cannot represent because no
// run ever started (an unreadable --trust file, an unreadable <file>, a
// malformed --envelope wrapper).
// ─────────────────────────────────────────────────────────────────────────────

export interface CliFailure {
	readonly step: string;
	readonly code: string;
	readonly detail: string;
}

export interface CliMissing {
	readonly what: string;
	readonly detail: string;
}

export interface ReceiptCliReport {
	readonly reportVersion: 1;
	readonly verdict: ReceiptVerdict | "FAILED" | "UNVERIFIABLE";
	readonly trustSnapshot: TrustSnapshotIdentity | null;
	readonly receiptId: string | null;
	readonly steps: ReceiptReport["steps"] | null;
	readonly checks: ReceiptReport["checks"] | null;
	readonly arrivalContext: { readonly result: string; readonly expected: string | null };
	readonly computed: { readonly amountUsd: string | null };
	readonly unimplemented: readonly string[];
	readonly posture: ReceiptReport["posture"];
	readonly limitations: readonly string[];
	readonly failure: CliFailure | null;
	readonly missing: CliMissing | null;
}

/** R-OUT-2: the rung is machine-readable — 0 for every `VERIFIED_*` value. */
export function exitCodeForReceiptVerdict(verdict: ReceiptCliReport["verdict"]): 0 | 1 | 2 {
	if (verdict === "FAILED") return 1;
	if (verdict === "UNVERIFIABLE") return 2;
	return 0;
}

/** The R-OUT obligations that hold whatever the amount covers. */
const BASE_VERIFIED_LIMITATIONS: readonly string[] = [
	"forkDisclaimer",
	"artifactVacuum",
	"supersessionUnknown",
];

/**
 * The machine-readable half of §7's REQUIRED verifier behavior for
 * `delegationPosture` — ONE caveat per value, keyed by the same value the
 * human report keys `DELEGATION_LABELS` by.
 *
 * `delegatedSpendExcluded` used to be emitted on every verified verdict, which
 * flatly contradicted the posture the same report stated: a JSON consumer
 * reading `posture.delegation: "includesSomeDelegated"` and
 * `limitations: [… "delegatedSpendExcluded"]` got two different answers about
 * the amount's scope from one document, and the wrong one was the one written
 * as a machine-readable fact.
 *
 * `includesAllDelegated` is absent by construction, not by omission: §2a makes
 * it an integrity failure in v1 (no signed-evidence format exists), so it never
 * reaches a verified verdict and therefore never reaches this table.
 */
export const DELEGATION_LIMITATIONS: Readonly<Record<string, string>> = {
	selfDebitsOnly: "delegatedSpendExcluded",
	includesSomeDelegated: "incompleteAttributedSubtotal",
	indeterminate: "coverageNotVerifiable",
};

function limitationsFor(
	verdict: ReceiptCliReport["verdict"],
	posture: ReceiptReport["posture"],
): readonly string[] {
	// R-OUT obligations travel with every VERIFIED_* rung, not with the top
	// rung alone (CLI spec §6: "the equivocation caveat… travelling WITH the
	// history claim, never with the rung alone — PR #92's defect"). The base
	// fork disclaimer and R-OUT-3/4 are unconditional at every rung too.
	if (verdict === "FAILED" || verdict === "UNVERIFIABLE") return [];
	// A verified verdict always carries a posture (step 7 releases it, and step
	// 7 fails closed on a value it cannot interpret), so the fallback is
	// unreachable — and it is `coverageNotVerifiable` rather than nothing
	// because "we could not name what this amount covers" is exactly the
	// statement that value makes. Emitting no delegation caveat at all would be
	// the silent-scope defect §2a exists to close.
	const delegation = posture === null ? undefined : DELEGATION_LIMITATIONS[posture.delegation];
	return [...BASE_VERIFIED_LIMITATIONS, delegation ?? "coverageNotVerifiable"];
}

/** Builds the terminal report from a completed `ReceiptReport` run. */
function fromReceiptReport(
	report: ReceiptReport,
	trustSnapshot: TrustSnapshotIdentity,
): ReceiptCliReport {
	return {
		reportVersion: 1,
		verdict: report.verdict,
		trustSnapshot,
		receiptId: report.receiptId,
		steps: report.steps,
		checks: report.checks,
		arrivalContext: report.arrivalContext,
		computed: report.computed,
		unimplemented: report.unimplemented,
		posture: report.posture,
		limitations: limitationsFor(report.verdict, report.posture),
		failure: report.failure,
		missing: report.missing,
	};
}

/** A refusal that never reached `verifyReceipt` — nothing ran, so the step
 * ledger is `null` rather than a fabricated all-`unavailable` shape §6 never
 * asked for. */
function preRunReport(outcome: {
	readonly verdict: "FAILED" | "UNVERIFIABLE";
	readonly trustSnapshot: TrustSnapshotIdentity | null;
	readonly failure?: CliFailure;
	readonly missing?: CliMissing;
	/** The §12-validated `--expect-id`, when the caller supplied one. */
	readonly arrivalId?: string;
}): ReceiptCliReport {
	return {
		reportVersion: 1,
		verdict: outcome.verdict,
		trustSnapshot: outcome.trustSnapshot,
		receiptId: null,
		steps: null,
		checks: null,
		// The same rule the base run applies: a supplied arrival context that
		// never got compared is `unavailable`, not `notApplicable`. Nothing ran
		// here at all, which makes it the clearest case of the two.
		arrivalContext:
			outcome.arrivalId === undefined
				? { result: "notApplicable", expected: null }
				: { result: "unavailable", expected: outcome.arrivalId },
		computed: { amountUsd: null },
		unimplemented: [],
		posture: null,
		limitations: [],
		failure: outcome.failure ?? null,
		missing: outcome.missing ?? null,
	};
}

/**
 * Sanitizes every untrusted free-text field the report carries, in EITHER
 * output format. `--json` is not exempt from AGENTS.md's terminal-safety
 * rule: `| jq` and `cat` both forward raw bytes, so a control character
 * smuggled into `failure.detail` (which embeds keyIds, e.g. "key
 * <keyId> is revoked…") is exactly as dangerous piped as it is in the human
 * report. `step`/`code`/`what` are drawn from this module's own closed
 * vocabularies and need no scrubbing; every `detail`, `receiptId`, and
 * snapshot `version`/`predecessor` does, because all of them come out of a
 * document the party under audit controls.
 */
function sanitizeCliReport(report: ReceiptCliReport): ReceiptCliReport {
	const sanitizeOutcome = <T extends { failure?: { code: string; detail: string } }>(
		outcome: T,
	): T =>
		outcome.failure === undefined
			? outcome
			: { ...outcome, failure: { ...outcome.failure, detail: clip(outcome.failure.detail) } };

	return {
		...report,
		receiptId: report.receiptId === null ? null : clip(report.receiptId),
		trustSnapshot:
			report.trustSnapshot === null
				? null
				: {
						sha256: report.trustSnapshot.sha256,
						version: clipNullable(report.trustSnapshot.version),
						predecessor: clipNullable(report.trustSnapshot.predecessor),
					},
		steps:
			report.steps === null
				? null
				: (Object.fromEntries(
						Object.entries(report.steps).map(([name, outcome]) => [name, sanitizeOutcome(outcome)]),
					) as ReceiptCliReport["steps"]),
		checks:
			report.checks === null
				? null
				: (Object.fromEntries(
						Object.entries(report.checks).map(([name, outcome]) => [
							name,
							sanitizeOutcome(outcome),
						]),
					) as ReceiptCliReport["checks"]),
		arrivalContext: {
			result: report.arrivalContext.result,
			expected: clipNullable(report.arrivalContext.expected),
		},
		failure:
			report.failure === null ? null : { ...report.failure, detail: clip(report.failure.detail) },
		missing:
			report.missing === null ? null : { ...report.missing, detail: clip(report.missing.detail) },
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The resolver envelope (CLI spec §3). `<file>`'s bytes are the ENVELOPE in
// this mode; the receipt input becomes its `receiptBytes` member, never the
// `receipt` convenience copy.
// ─────────────────────────────────────────────────────────────────────────────

/** §4.1's three receipt-bearing ladder statuses — the ONLY ones this CLI's
 * `--envelope` mode has anything to verify. */
const RECEIPT_BEARING_STATUSES: ReadonlySet<string> = new Set([
	"verified_checkpoint",
	"verified_checkpoint_history",
	"verified_anchored",
]);

type EnvelopeOutcome =
	| { readonly kind: "usage"; readonly message: string }
	| { readonly kind: "missing"; readonly detail: string }
	| { readonly kind: "failed"; readonly code: string; readonly detail: string }
	| {
			readonly kind: "ok";
			readonly receiptBytes: Uint8Array;
			readonly extensions: ReceiptExtensionMaterial;
	  };

/**
 * Resolves the envelope down to the bytes `verifyReceipt` needs, or a reason
 * it cannot. Every branch of CLI spec §3 in one place: the protocol checks
 * (`apiVersion`, receipt-bearing `status`), the R4 agreement check (bytes ↔
 * copy, envelope-id ↔ receipt-id — a STRUCTURAL comparison over canonical
 * bytes, since key order in the convenience copy is not itself a defect),
 * and the extraction of step 9's optional material.
 */
export function resolveEnvelope(bytes: Uint8Array): EnvelopeOutcome {
	const parsed = readStrictJson(bytes);
	if (!parsed.ok) {
		return { kind: "missing", detail: `the envelope did not parse: ${parsed.refusal.detail}` };
	}
	if (!isJsonObject(parsed.value)) {
		return { kind: "missing", detail: "the envelope is not a JSON object" };
	}
	const envelope = parsed.value;

	// §3: "apiVersion MUST be "1" — an unsupported version is a PROTOCOL
	// error, not missing receipt material… so it is FAILED, not
	// UNVERIFIABLE." `ENVELOPE_INVALID` is a CLI-layer code: the envelope
	// wraps the receipt-spec §7 vocabulary rather than belonging to it, since
	// none of §7's nine steps run over the resolver's own framing.
	if (envelope.apiVersion !== "1") {
		return {
			kind: "failed",
			code: "ENVELOPE_INVALID",
			detail: `envelope apiVersion is ${JSON.stringify(envelope.apiVersion)}, not the supported "1"`,
		};
	}

	const status = envelope.status;
	if (typeof status !== "string" || !RECEIPT_BEARING_STATUSES.has(status)) {
		// §3: "a non-receipt envelope… exits 3 — the caller handed the wrong
		// document to the wrong mode." Not a verdict at all: there is no
		// receipt here to render one about.
		return {
			kind: "usage",
			message: `the envelope's status is ${JSON.stringify(status)} — this is not a receipt-bearing response, so there is nothing for receipt mode to verify`,
		};
	}

	// The status IS receipt-bearing, so an absent/non-string `receiptBytes` is
	// a defect of THIS envelope, not a wrong-mode usage mistake (§5's table:
	// "missing receiptBytes" is UNVERIFIABLE, exit 2 — the same split
	// `runReceiptCli` already draws for the default-mode input).
	const rawReceiptBytes = envelope.receiptBytes;
	if (typeof rawReceiptBytes !== "string") {
		return {
			kind: "missing",
			detail: `the envelope's status is ${JSON.stringify(status)} (receipt-bearing) but receiptBytes is ${rawReceiptBytes === undefined ? "absent" : "not a string"}`,
		};
	}

	const decoded = decodeCanonicalBase64(rawReceiptBytes);
	if (decoded === null) {
		return { kind: "missing", detail: "envelope.receiptBytes is not canonical base64" };
	}

	// R4, checkable as soon as the bytes are JSON AT ALL — and no sooner. When
	// they are not, step 1 owns reporting it on the `verifyReceipt` call this
	// function's caller makes next; a second "unparseable" message here would
	// just be step 1's, spoken early.
	//
	// It is deliberately NOT `readReceiptDocument`. R4 asks whether the
	// FRAMING agrees with the bytes, and that question does not need the bytes
	// to be a valid ut1 document — gating it on the full schema meant a
	// resolver holding bytes that parsed but failed §5 could omit or rewrite
	// the convenience copy and the envelope `receiptId` for free: the run
	// reported SCHEMA_INVALID, a statement about the RECEIPT, and never
	// mentioned that the envelope had lied about which receipt this was. §3 is
	// explicit that a mismatch "is an ENVELOPE integrity failure, not
	// SCHEMA_INVALID". Using the same `readStrictJson` on both sides also makes
	// the comparison symmetric: the copy has never run through the frozen
	// numeric rules either.
	const strict = readStrictJson(decoded);
	if (strict.ok) {
		const bytesValue = strict.value;
		const copy = envelope.receipt;
		// STRUCTURAL, not canonical-string. Neither side ran through
		// `readReceiptDocument`'s frozen numeric rules, so both can carry
		// anything JSON can express, including values a serializer erases.
		// `canonicalize` renders `-0` as `0` and THROWS on `1e999`; comparing
		// its output would therefore report agreement between a copy and bytes
		// that differ, and would make a hostile copy a crash rather than a
		// verdict. `structurallyEqualJson` compares numbers with `Object.is`,
		// ignores key ORDER (which is not a defect in a convenience copy), and
		// never serializes either side.
		const bytesMatchCopy = copy !== undefined && structurallyEqualJson(bytesValue, copy);
		// Bytes that are JSON but not an OBJECT carry no `receiptId`, so the
		// envelope's claimed id agrees with nothing — a disagreement, not a
		// reason to skip the equality.
		const bytesReceiptId = isJsonObject(bytesValue) ? bytesValue.receiptId : undefined;
		const idsMatch =
			typeof envelope.receiptId === "string" && envelope.receiptId === bytesReceiptId;
		if (!bytesMatchCopy || !idsMatch) {
			// §3: "a mismatch is an ENVELOPE integrity failure, not
			// SCHEMA_INVALID… a detail naming which of the three equalities
			// broke."
			const broken =
				!bytesMatchCopy && !idsMatch
					? "both bytes↔copy and envelope-id↔receipt-id"
					: !bytesMatchCopy
						? "bytes↔copy"
						: "envelope-id↔receipt-id";
			return {
				kind: "failed",
				code: "ENVELOPE_INVALID",
				detail: `the R4 envelope agreement check failed: ${broken} disagree`,
			};
		}
	}

	const extensions: ReceiptExtensionMaterial = {
		...(envelope.checkpointHistory !== undefined
			? { checkpointHistory: envelope.checkpointHistory as JsonValue }
			: {}),
		...(envelope.anchorEvidence !== undefined
			? { anchorEvidence: envelope.anchorEvidence as JsonValue }
			: {}),
	};
	return { kind: "ok", receiptBytes: decoded, extensions };
}

// ─────────────────────────────────────────────────────────────────────────────
// Human report (CLI spec §6). Verdict first, always — every field after it
// is sanitized before it is ever concatenated, so nothing appended later can
// retroactively corrupt what already looks like a printed verdict line.
// ─────────────────────────────────────────────────────────────────────────────

export const CHECKPOINT_RUNG_DISCLAIMER =
	"This does not prove whole-chain linear consistency, anchor-sequence continuity, or external immutability — a checkpoint signer could sign a fork.";

export const HISTORY_EQUIVOCATION_CAVEAT =
	"Equivocation is not closed at this rung: nothing above stops the checkpoint key's holder from signing two different sealed-segment histories and showing one to you and another to someone else. Closing it needs witness cosigning or a public append-only checkpoint log — a named non-goal for v1.";

export const SUPERSESSION_CAVEAT =
	"This verdict is relative to the pinned trust snapshot named above and does not imply the receipt has not since been superseded.";

export const ARTIFACT_VACUUM_CAVEAT =
	"This verifies the RECEIPT only, not any artifact that cites it — a consumer holding the containing artifact must additionally apply its own per-kind transplant rule.";

export const ESTIMATES_CAVEAT =
	"The usage posture is estimated or mixed: the underlying token/call counts are not all provider-attested.";

export const DELEGATION_LABELS: Readonly<Record<string, string>> = {
	selfDebitsOnly: "direct / self-account spend; delegated spend out of scope",
	includesSomeDelegated: "an incomplete attributed subtotal",
	indeterminate: "end-to-end coverage that cannot be verified",
	includesAllDelegated: "the total cost of work caused by the subject only",
};

function describeStep(
	name: string,
	outcome: { result: string; failure?: { code: string } },
): string {
	const detail = outcome.failure ? ` (${outcome.failure.code})` : "";
	return `  ${name.padEnd(12)} ${outcome.result}${detail}`;
}

/**
 * One of §7's named checks — with its DETAIL when it failed.
 *
 * §7 step 9 is upgrade-only: a broken checkpoint history never demotes the
 * base verdict, so `report.failure` stays null and the `Failed step:` block —
 * the only place the human report ever printed a detail — does not render.
 * That left the reader with `Checkpoint history: failed` and nothing else,
 * which does not distinguish a short history from a broken lineage edge from a
 * checkpoint signed by the wrong key. The detail exists, it is already
 * sanitized by `sanitizeCliReport`, and CLI spec §6 does not make `--json` the
 * only honest mode.
 */
function pushCheck(
	lines: string[],
	label: string,
	outcome: { result: string; failure?: { code: string; detail: string } },
): void {
	const failure = outcome.failure;
	lines.push(`${label}: ${outcome.result}${failure === undefined ? "" : ` (${failure.code})`}`);
	if (failure !== undefined) lines.push(`  ${clip(failure.detail)}`);
}

function renderHumanReport(report: ReceiptCliReport): string {
	const lines: string[] = [];
	lines.push(`Verdict: ${report.verdict}`);
	lines.push("");

	if (report.trustSnapshot !== null) {
		const version = clipNullable(report.trustSnapshot.version);
		const predecessor = clipNullable(report.trustSnapshot.predecessor);
		lines.push(
			`Trust snapshot: sha256:${report.trustSnapshot.sha256}` +
				(version !== null ? ` (version ${version})` : "") +
				(predecessor !== null ? ` (predecessor sha256:${predecessor})` : ""),
		);
	}
	if (report.receiptId !== null) lines.push(`Receipt: ${clip(report.receiptId)}`);

	if (report.missing !== null) {
		lines.push("");
		lines.push(`Missing required material: ${clip(report.missing.what)}`);
		lines.push(`  ${clip(report.missing.detail)}`);
		// No early return: `missing` and `failure` are mutually exclusive (a
		// run is either UNVERIFIABLE or FAILED, never both), but `verifyReceipt`
		// can still have produced a partial step ledger and named checks before
		// settling on UNVERIFIABLE (e.g. a receipt missing `proof`) — CLI spec
		// §6 requires both in the human report, on every verdict, not just on
		// success. Falling through lets the `steps`/`checks` blocks below run
		// exactly as they do for FAILED/VERIFIED_*, guarded by their own
		// `!== null` checks so a true pre-run refusal (steps/checks both null)
		// still renders nothing extra.
	}

	if (report.failure !== null) {
		lines.push("");
		lines.push(`Failed step: ${clip(report.failure.step)} (${clip(report.failure.code)})`);
		lines.push(`  ${clip(report.failure.detail)}`);
	}

	if (report.steps !== null) {
		lines.push("");
		lines.push("Steps:");
		for (const [name, outcome] of Object.entries(report.steps)) {
			lines.push(describeStep(name, outcome));
		}
	}
	if (report.checks !== null) {
		lines.push("");
		lines.push(
			`Arrival check (3a): ${report.arrivalContext.result}` +
				(report.arrivalContext.expected !== null
					? ` (expected ${clip(report.arrivalContext.expected)})`
					: ""),
		);
		lines.push(
			`Registry binding (3b): ${report.checks.registryBinding.result} — offline; no resolver was consulted (§7's Offline column)`,
		);
		pushCheck(lines, "Predecessor linkage", report.checks.predecessorLinkage);
		pushCheck(lines, "Checkpoint history", report.checks.checkpointHistory);
		// `anchorEvidence` is present in `checks` ONLY when evidence was absent
		// (notApplicable, fully conformant per §5); when evidence was supplied
		// it is omitted here and named in `unimplemented` instead — reporting
		// both would claim a §7 result the CLI never produced.
		if (report.checks.anchorEvidence !== undefined) {
			pushCheck(lines, "Anchor evidence", report.checks.anchorEvidence);
		}
	}
	if (report.unimplemented.length > 0) {
		lines.push("");
		for (const name of report.unimplemented) {
			lines.push(
				`UNIMPLEMENTED: ${name} was supplied but this build does not validate it — the rung is capped below verified_anchored.`,
			);
		}
	}

	if (report.computed.amountUsd !== null && report.posture !== null) {
		const label = DELEGATION_LABELS[report.posture.delegation] ?? report.posture.delegation;
		lines.push("");
		lines.push(
			`Amount: $${report.computed.amountUsd} USD — ${label} (${report.posture.delegation})`,
		);
		lines.push(
			`Usage posture: ${clip(report.posture.usage)}   Pricing posture: ${clip(report.posture.pricing)}`,
		);
	}

	if (report.limitations.length > 0) {
		lines.push("");
		lines.push(CHECKPOINT_RUNG_DISCLAIMER);
		// The delegation caveat needs no line of its own at any posture: the
		// `Amount:` line above already carries §7's per-value label, which is
		// the same row `DELEGATION_LIMITATIONS` renders for `--json` (§5's "the
		// amount is never rendered without its label" obligation). The two
		// halves are keyed by one value so they cannot drift apart again.
		if (
			report.verdict === "VERIFIED_CHECKPOINT_HISTORY" ||
			report.verdict === "VERIFIED_ANCHORED"
		) {
			lines.push(HISTORY_EQUIVOCATION_CAVEAT);
		}
		lines.push(SUPERSESSION_CAVEAT);
		lines.push(ARTIFACT_VACUUM_CAVEAT);
		if (
			report.posture !== null &&
			(report.posture.usage === "estimated" || report.posture.usage === "mixed")
		) {
			lines.push(ESTIMATES_CAVEAT);
		}
	}

	return lines.join("\n");
}

function renderJsonReport(report: ReceiptCliReport): string {
	return JSON.stringify(report);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point.
// ─────────────────────────────────────────────────────────────────────────────

function finish(
	rawReport: ReceiptCliReport,
	json: boolean,
	diagnostics: readonly string[],
): ReceiptCliResult {
	// Sanitized ONCE, upstream of both renderers — `--json` is not exempt
	// from terminal safety (see `sanitizeCliReport`'s own header).
	const report = sanitizeCliReport(rawReport);
	const exitCode = exitCodeForReceiptVerdict(report.verdict);
	const stderr = diagnostics.length > 0 ? `${diagnostics.map(clip).join("\n")}\n` : "";
	// §6: "stdout carries the JSON object and nothing else… so `| jq` is
	// safe." The human report also carries nothing but the report — any
	// operational diagnostics (e.g. an I/O error's raw message) go to stderr
	// in both modes, never interleaved into stdout.
	return {
		exitCode,
		stdout: json ? `${renderJsonReport(report)}\n` : `${renderHumanReport(report)}\n`,
		stderr,
	};
}

function usageResult(message: string): ReceiptCliResult {
	return { exitCode: 3, stdout: "", stderr: `${clip(message)}\n\n${RECEIPT_USAGE}\n` };
}

function describeIoError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readBytes(path: string, io: ReceiptCliIo): Buffer {
	return path === "-" ? io.readStdin() : io.readFile(path);
}

export function runReceiptCli(argv: readonly string[], io: ReceiptCliIo): ReceiptCliResult {
	const parsed = parseReceiptArgs(argv);
	// Exit 3, not 0: §6's exit table is closed and reserves 0 for
	// `VERIFIED_CHECKPOINT` or higher — no verdict was reached here, nothing
	// was verified, and `--help` is recognized at ANY argv position (matching
	// `-h`/`--help` in vault mode's own loop, cli.ts:241), so an unsanitized
	// `<file>` argument of literally "--help" must not be able to make a
	// scripted caller that keys on exit status believe a receipt verified.
	// 3 puts it in the same "no verdict reached" bucket as every other usage
	// refusal below, which is what receipt mode's dedicated exit-3 handler
	// exists to guarantee (never the shared vault `usage()`, which exits 1).
	if (parsed.kind === "help") return { exitCode: 3, stdout: `${RECEIPT_USAGE}\n`, stderr: "" };
	if (parsed.kind === "error") return usageResult(parsed.message);
	const { file, trust, envelope, expectId, json } = parsed.args;

	// `--expect-id` is USAGE-invalid, not silently notApplicable, when it is
	// present but does not parse as a §12 arrival form: an operator who typed
	// a real flag deserves to be told it was not understood, not to have step
	// 3(a) quietly skipped (CLI spec §2).
	let arrivalId: string | undefined;
	if (expectId !== undefined) {
		const id = receiptIdFromArrivalContext(expectId);
		if (id === null) {
			return usageResult(
				`--expect-id ${JSON.stringify(expectId)} is not a bare ut1_… id, a resolution URL, or a Usertrust-Receipt: trailer line`,
			);
		}
		arrivalId = id;
	}

	// The §8 trust snapshot. Required, pinned, no fetch (CLI spec §2): its
	// absence — as a FILE, not as the flag, which `parseReceiptArgs` already
	// owns — is missing material, never a usage error (§6: "no condition
	// maps to two codes").
	let trustBytes: Buffer;
	try {
		trustBytes = io.readFile(trust);
	} catch (error) {
		return finish(
			preRunReport({
				verdict: "UNVERIFIABLE",
				trustSnapshot: null,
				missing: { what: "trustSnapshot", detail: describeIoError(error) },
				...(arrivalId === undefined ? {} : { arrivalId }),
			}),
			json,
			[],
		);
	}
	const trustLoad = loadTrustSnapshot(trustBytes);
	if (!trustLoad.ok) {
		return finish(
			preRunReport({
				verdict: "UNVERIFIABLE",
				trustSnapshot: { sha256: trustLoad.sha256, version: null, predecessor: null },
				missing: { what: "trustSnapshot", detail: trustLoad.detail },
				...(arrivalId === undefined ? {} : { arrivalId }),
			}),
			json,
			[],
		);
	}
	const snapshotIdentity = trustLoad.snapshot.identity;

	// The receipt input. `<file>`'s absence as a POSITIONAL is already a
	// usage error above; its absence as a READABLE file is missing material —
	// the same split CLI spec §6 draws for `--trust`.
	let inputBytes: Buffer;
	try {
		inputBytes = readBytes(file, io);
	} catch (error) {
		return finish(
			preRunReport({
				verdict: "UNVERIFIABLE",
				trustSnapshot: snapshotIdentity,
				missing: { what: "receiptBytes", detail: describeIoError(error) },
				...(arrivalId === undefined ? {} : { arrivalId }),
			}),
			json,
			[],
		);
	}

	let receiptBytes: Uint8Array;
	let extensions: ReceiptExtensionMaterial | undefined;
	if (envelope) {
		const outcome = resolveEnvelope(inputBytes);
		if (outcome.kind === "usage") return usageResult(outcome.message);
		if (outcome.kind === "missing") {
			return finish(
				preRunReport({
					verdict: "UNVERIFIABLE",
					trustSnapshot: snapshotIdentity,
					missing: { what: "receiptBytes", detail: outcome.detail },
					...(arrivalId === undefined ? {} : { arrivalId }),
				}),
				json,
				[],
			);
		}
		if (outcome.kind === "failed") {
			return finish(
				preRunReport({
					verdict: "FAILED",
					trustSnapshot: snapshotIdentity,
					failure: { step: "envelope", code: outcome.code, detail: outcome.detail },
					...(arrivalId === undefined ? {} : { arrivalId }),
				}),
				json,
				[],
			);
		}
		receiptBytes = outcome.receiptBytes;
		extensions = outcome.extensions;
	} else {
		receiptBytes = inputBytes;
	}

	const report = verifyReceipt({
		receiptBytes,
		snapshot: trustLoad.snapshot,
		...(arrivalId !== undefined ? { arrivalId } : {}),
		...(extensions !== undefined ? { extensions } : {}),
	});
	return finish(fromReceiptReport(report, snapshotIdentity), json, []);
}

// Re-exported so `cli.ts`'s dispatch check stays a one-line string compare
// against the same literal this module treats as `argv[0]`.
export const RECEIPT_DISPATCH_TOKEN = "receipt";
