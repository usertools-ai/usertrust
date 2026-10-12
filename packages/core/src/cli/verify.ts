// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust verify — Verify audit chain integrity
 *
 * Calls verifyVaultReading() on the local vault (anchored to the `.meta` head,
 * spans rotated segments), judges the dead letters and the caller's receipts
 * against the events that read verified, and displays the result. Sets a
 * nonzero process exit code on a FAILED verdict so CI gates fail on a tampered
 * vault.
 *
 * External-anchor flags (spec §7.5) mirror the standalone usertrust-verify
 * CLI: the caller fetches anchor artifacts and pins the public key
 * out-of-band; trust is never read from the vault under audit.
 */

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import pc from "picocolors";
import { parseAnchorsContent } from "../audit/anchor-verify.js";
import { deadLettersAgainst, verifyVaultComplete } from "../audit/complete.js";
import {
	type ChainDeadLetters,
	type ChainDeadLettersUnreadable,
	describeMissingEvents,
} from "../audit/dead-letters.js";
import type { PersistedAuditEvent } from "../audit/read.js";
import {
	type AnchorVerifyParams,
	exitCodeForAnchored,
	verifyVaultWithAnchorsReading,
	type WitnessInput,
} from "../audit/verify.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { ActionKind } from "../shared/types.js";
import { GLOBAL_FLAGS } from "./flags.js";
import type { CliOptions } from "./init.js";
import { scrubForTerminal, toSafeJson, warnIfVaultLoose } from "./target.js";

function parseDurationMs(raw: string): number {
	const m = /^(\d+)(ms|s|m|h|d)?$/.exec(raw);
	if (m === null) {
		// Silently dropping the policy would quietly disable the staleness
		// gate — the exact fail-open the unknown-flag rejection exists to stop.
		throw new Error(`Invalid --max-anchor-age: ${raw} (use e.g. 500ms, 30s, 15m, 1h, 7d)`);
	}
	const n = Number.parseInt(m[1] as string, 10);
	const mult = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "ms"] as number;
	return n * mult;
}

interface AnchorFlags {
	/**
	 * Bare (non-flag) arguments, in order. Only collected when the caller passed the arguments
	 * explicitly: the legacy `process.argv` fallback holds the command word and, under a test
	 * runner, the runner's own arguments, none of which name a vault.
	 */
	targets: string[];
	/** Single-dash tokens: there are no short flags, so each one is an error. */
	dashTokens: string[];
	anchorMode: boolean;
	params: AnchorVerifyParams;
	requireAnchor: boolean;
	requireExternalAnchor: boolean;
	/** `--receipts` contents, read: the caller's own receipts, checked against the chain. */
	receiptsRaw: string[];
}

const KNOWN_VERIFY_FLAGS = new Set([
	// Global flags main.ts accepts for every subcommand — rejecting them here
	// would break existing `usertrust verify --skip-verify`-style invocations.
	...GLOBAL_FLAGS,
	// Anchor flags.
	"--anchor",
	"--anchors",
	"--anchor-url",
	"--bundle",
	"--rekor-receipts",
	"--rekor-pubkey",
	"--pubkey",
	"--successor-pin",
	"--require-anchor",
	"--require-external-anchor",
	"--max-anchor-age",
	"--max-unanchored-events",
	"--vault-id",
	// The caller's receipts, cross-checked against the chain (not an anchor flag).
	"--receipts",
]);

const MAX_PEM_BYTES = 16 * 1024;
const MAX_BUNDLE_ITEMS = 10_000;
const BUNDLE_KEYS = new Set(["v", "records", "rekorReceipts"]);

function readArtifact(pathOrDash: string): string {
	return pathOrDash === "-" ? readFileSync(0, "utf-8") : readFileSync(pathOrDash, "utf-8");
}

/**
 * Read one pinned log key. A file that carries no usable PEM is a usage error,
 * not an empty pin: the verifier discards unusable entries, so accepting one
 * here would leave the caller believing they pinned a key while the receipt was
 * checked against something else entirely.
 */
function readPinnedPem(path: string): string {
	const pem = readFileSync(path, "utf-8");
	if (Buffer.byteLength(pem, "utf8") > MAX_PEM_BYTES) {
		throw new Error(`--rekor-pubkey ${path}: PEM exceeds 16 KiB`);
	}
	if (pem.trim().length === 0 || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
		throw new Error(
			`--rekor-pubkey ${path}: not a PEM public key (-----BEGIN PUBLIC KEY----- missing)`,
		);
	}
	return pem;
}

// Matching control characters is the entire point here — they are what gets
// removed from anything echoed back to a terminal.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the intent
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

/**
 * An untrusted field NAME on its way into an error string. Control characters
 * are stripped before truncation: these strings are printed to a terminal, and
 * an escape sequence inside a key would let the party under audit repaint the
 * line its own verdict is printed on.
 */
function clipKey(key: string): string {
	const scrubbed = key.replace(CONTROL_CHARS, "");
	return scrubbed.length <= 80 ? scrubbed : `${scrubbed.slice(0, 80)}...`;
}

/**
 * Strict parse of an auditor bundle: `{v:1, records, rekorReceipts?}`. A bundle
 * is untrusted transport, so unknown top-level fields are rejected rather than
 * ignored — a field the CLI silently drops is one an exporter can use to carry
 * evidence the verifier never looks at. Element shapes are NOT validated here:
 * records and receipts are re-serialized and go through the same strict parsers
 * every other input does.
 */
function parseBundle(raw: string): { anchorsRaw: string; receiptsRaw: string[] } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("--bundle: not valid JSON");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("--bundle: not an object");
	}
	const obj = parsed as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!BUNDLE_KEYS.has(key)) throw new Error(`--bundle: unknown field "${clipKey(key)}"`);
	}
	if (obj.v !== 1) throw new Error("--bundle: unsupported version (expected 1)");
	if (!Array.isArray(obj.records)) throw new Error("--bundle: records must be an array");
	if (obj.records.length > MAX_BUNDLE_ITEMS) {
		throw new Error(`--bundle: records exceeds the ${MAX_BUNDLE_ITEMS} cap`);
	}
	const receipts = obj.rekorReceipts ?? [];
	if (!Array.isArray(receipts)) throw new Error("--bundle: rekorReceipts must be an array");
	if (receipts.length > MAX_BUNDLE_ITEMS) {
		throw new Error(`--bundle: rekorReceipts exceeds the ${MAX_BUNDLE_ITEMS} cap`);
	}
	return {
		anchorsRaw: obj.records.map((record) => toSafeJson(record)).join("\n"),
		receiptsRaw: receipts.map((receipt) => toSafeJson(receipt)),
	};
}

function fetchAnchorUrl(url: string): Promise<{ ok: boolean; body?: string; error?: string }> {
	return new Promise((resolve) => {
		import("node:https")
			.then((https) => {
				const req = https.get(url, { timeout: 15_000 }, (res) => {
					const code = res.statusCode ?? 0;
					if (code < 200 || code >= 300) {
						res.resume();
						resolve({ ok: false, error: `HTTP ${code}` });
						return;
					}
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () => resolve({ ok: true, body: Buffer.concat(chunks).toString("utf-8") }));
				});
				req.on("timeout", () => req.destroy(new Error("timeout")));
				req.on("error", (err) => resolve({ ok: false, error: err.message }));
			})
			.catch((err: Error) => resolve({ ok: false, error: err.message }));
	});
}

async function parseAnchorFlags(argv: string[], collectTargets: boolean): Promise<AnchorFlags> {
	const targets: string[] = [];
	const dashTokens: string[] = [];
	const anchorFiles: string[] = [];
	const rekorReceiptFiles: string[] = [];
	const rekorPubkeyFiles: string[] = [];
	let bundleFile: string | undefined;
	let anchorUrl: string | undefined;
	let pubkeyFile: string | undefined;
	const successorPinFiles: string[] = [];
	let requireAnchor = false;
	let requireExternalAnchor = false;
	let maxAnchorAgeMs: number | undefined;
	let maxUnanchoredEvents: number | undefined;
	let vaultId: string | undefined;
	const receiptFiles: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const next = (): string | undefined => argv[++i];
		if (arg === "--anchor" || arg === "--anchors") {
			const v = next();
			if (v !== undefined) anchorFiles.push(v);
		} else if (arg === "--rekor-receipts") {
			const v = next();
			if (v !== undefined) rekorReceiptFiles.push(v);
		} else if (arg === "--rekor-pubkey") {
			const v = next();
			if (v !== undefined) rekorPubkeyFiles.push(v);
		} else if (arg === "--bundle") bundleFile = next();
		else if (arg === "--anchor-url") anchorUrl = next();
		else if (arg === "--pubkey") pubkeyFile = next();
		else if (arg === "--successor-pin") {
			const v = next();
			if (v !== undefined) successorPinFiles.push(v);
		} else if (arg === "--require-anchor") requireAnchor = true;
		else if (arg === "--require-external-anchor") requireExternalAnchor = true;
		else if (arg === "--max-anchor-age") {
			const v = next();
			if (v === undefined) throw new Error("--max-anchor-age requires a value");
			maxAnchorAgeMs = parseDurationMs(v);
		} else if (arg === "--max-unanchored-events") {
			const v = next();
			maxUnanchoredEvents = Number.parseInt(v ?? "", 10);
			// parseInt("1O0") === 1 (partial parse) and NaN comparisons are always
			// false — either typo would silently weaken the staleness gate.
			// Require the WHOLE value to be a non-negative integer.
			if (
				!/^\d+$/.test(v ?? "") ||
				!Number.isSafeInteger(maxUnanchoredEvents) ||
				maxUnanchoredEvents < 0
			) {
				throw new Error(`Invalid --max-unanchored-events: ${v} (non-negative integer required)`);
			}
		} else if (arg === "--vault-id") vaultId = next();
		else if (arg === "--receipts") {
			const v = next();
			if (v === undefined) throw new Error("--receipts requires a file (or - for stdin)");
			receiptFiles.push(v);
		} else if (arg.startsWith("--") && !KNOWN_VERIFY_FLAGS.has(arg)) {
			// Reject unknown flags rather than silently ignoring them — a typoed
			// --require-anchro must not quietly weaken a CI gate.
			throw new Error(`Unknown flag: ${arg}`);
		} else if (collectTargets && !arg.startsWith("--")) {
			// Flag values were consumed by `next()` above, so what is left here is a path, or a
			// single-dash token. That token is NEVER skipped as a maybe-flag: `verify -vault`
			// ignored it and verified the cwd, the false PASS one character from the path asked for.
			(arg.startsWith("-") ? dashTokens : targets).push(arg);
		}
	}
	const externalAnchorsRaw = anchorFiles.map(readArtifact);
	const rekorReceiptsRaw = rekorReceiptFiles.map(readArtifact);
	const rekorLogPubkeysPem = rekorPubkeyFiles.map(readPinnedPem);
	if (bundleFile !== undefined) {
		const bundle = parseBundle(readArtifact(bundleFile));
		externalAnchorsRaw.push(bundle.anchorsRaw);
		rekorReceiptsRaw.push(...bundle.receiptsRaw);
	}
	let witness: WitnessInput = { requested: false };
	if (anchorUrl !== undefined) {
		const fetched = await fetchAnchorUrl(anchorUrl);
		// Empty/fully-unparseable body = witness unreachable (inconclusive).
		// A body with ANY cleanly parsed records IS evidence — keep it whole;
		// embedded parse errors fail closed downstream instead of discarding
		// the rollback proof the valid records carry.
		const parsed =
			fetched.ok && fetched.body !== undefined ? parseAnchorsContent(fetched.body) : null;
		if (parsed !== null && parsed.records.length > 0) {
			externalAnchorsRaw.push(fetched.body as string);
			witness = { requested: true, ok: true };
		} else {
			witness = {
				requested: true,
				ok: false,
				error: fetched.ok
					? "witness returned an empty or unparseable body"
					: (fetched.error ?? "fetch failed"),
			};
		}
	}
	const anchorMode =
		anchorFiles.length > 0 ||
		anchorUrl !== undefined ||
		pubkeyFile !== undefined ||
		bundleFile !== undefined ||
		rekorReceiptFiles.length > 0 ||
		requireAnchor ||
		requireExternalAnchor;
	const trust =
		pubkeyFile !== undefined
			? {
					rootPem: readFileSync(pubkeyFile, "utf-8"),
					...(successorPinFiles.length > 0
						? { successorPinsPem: successorPinFiles.map((f) => readFileSync(f, "utf-8")) }
						: {}),
				}
			: undefined;
	return {
		targets,
		dashTokens,
		anchorMode,
		requireAnchor,
		requireExternalAnchor,
		receiptsRaw: receiptFiles.map(readArtifact),
		params: {
			externalAnchorsRaw,
			rekorReceiptsRaw,
			rekorLogPubkeysPem,
			...(trust !== undefined ? { trust } : {}),
			witness,
			...(maxAnchorAgeMs !== undefined ? { maxAnchorAgeMs } : {}),
			...(maxUnanchoredEvents !== undefined ? { maxUnanchoredEvents } : {}),
			...(vaultId !== undefined ? { expectedVaultId: vaultId } : {}),
		},
	};
}

interface ReceiptCheck {
	checked: number;
	/** Receipts with no audit event of their own on the chain, and why. */
	unaudited: Array<{ transferId: string; reason: string }>;
	/** Entries that are not receipts this check can read: each counts as unaudited. */
	unreadable: number;
}

/**
 * The INDEPENDENT count: the caller's own receipts (`--receipts`: JSON Lines, or one JSON array),
 * each checked against `events`, the events the verification just walked (never the log read again,
 * where an event that was never hash-checked could audit a receipt). A receipt is audited only if its `auditHash` is its OWN event on
 * the chain: one whose `data.transferId` is its `transferId` and whose kind is the event that
 * records its spend (`llm_call`, or an action's `actionKind`). Another event of the same transfer (a
 * detection, a settlement follow-up) is not the spend record, and an event naming no transfer is
 * no receipt's. This sees a gap the dead-letter queue cannot: a dead letter whose own write failed,
 * or a queue someone deleted.
 *
 * A DEGRADED receipt (`auditHash: "AUDIT_DEGRADED"` from `trust()`, or `auditDegraded: true` with a
 * placeholder hash from a headless governor) names no event, though its own event may well be on the
 * chain: the primary append's `.meta` update failed after its bytes were synced, or the primary
 * landed and a follow-up event (a settlement shortfall, say) failed. It is audited only when the
 * chain just verified holds ITS OWN event: its transfer, and its kind. The dead-letter queue plays no
 * part here: it is not tamper-evident, and an event can reach the chain with no dead letter at all.
 */
function checkReceipts(events: readonly PersistedAuditEvent[], raws: string[]): ReceiptCheck {
	const byHash = new Map(events.map((e) => [e.hash, e]));
	// Each transfer's events on the chain, by kind: a degraded receipt's own event is found here.
	const ownEventOnChain = new Set<string>();
	for (const e of events) {
		const named = (e.data as { transferId?: unknown } | undefined)?.transferId;
		// A string kind only: an array or an object would stringify into one (`["llm_call"]`), or throw.
		if (typeof named === "string" && typeof e.kind === "string") {
			ownEventOnChain.add(`${named}\u0000${e.kind}`);
		}
	}
	const result: ReceiptCheck = { checked: 0, unaudited: [], unreadable: 0 };
	const entries: unknown[] = [];
	for (const raw of raws) {
		const text = raw.trim();
		// A receipts file the caller named that holds nothing is not "no receipts": a truncated or
		// empty export would otherwise pass the check with nothing checked. An explicit `[]` says it.
		if (text === "") {
			result.unreadable++;
			continue;
		}
		if (text.startsWith("[")) {
			try {
				const arr: unknown = JSON.parse(text);
				// One at a time: spreading a caller-sized array into one call throws past V8's
				// argument limit (about 120k), which read a valid file as unreadable.
				if (Array.isArray(arr)) for (const r of arr) entries.push(r);
				else result.unreadable++;
			} catch {
				result.unreadable++;
			}
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.trim() === "") continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				result.unreadable++;
			}
		}
	}
	for (const entry of entries) {
		const r = entry as {
			transferId?: unknown;
			auditHash?: unknown;
			auditDegraded?: unknown;
			actionKind?: unknown;
		} | null;
		if (
			r === null ||
			typeof r !== "object" ||
			typeof r.transferId !== "string" ||
			typeof r.auditHash !== "string"
		) {
			result.unreadable++;
			continue;
		}
		// `actionKind`, when present, must name a governed action: any other kind (a settlement
		// follow-up, a detection) would let a modified receipt match an event that is not its spend.
		if (r.actionKind !== undefined && !isActionKind(r.actionKind)) {
			result.unreadable++;
			continue;
		}
		result.checked++;
		// The kind of the event that records this receipt's spend: its action's, or an LLM call's.
		const ownKind = r.actionKind ?? "llm_call";
		const event = r.auditHash === "AUDIT_DEGRADED" ? undefined : byHash.get(r.auditHash);
		if (event !== undefined) {
			const named = (event.data as { transferId?: unknown } | undefined)?.transferId;
			if (named !== r.transferId) {
				result.unaudited.push({
					transferId: r.transferId,
					reason:
						typeof named === "string"
							? `its auditHash is ${named}'s event`
							: "its auditHash is an event that names no transfer",
				});
			} else if (event.kind !== ownKind) {
				result.unaudited.push({
					transferId: r.transferId,
					reason: `its auditHash is its ${typeof event.kind === "string" ? event.kind : "malformed"} event, not the ${ownKind} that records its spend`,
				});
			}
			continue;
		}
		if (r.auditHash === "AUDIT_DEGRADED" || r.auditDegraded === true) {
			if (!ownEventOnChain.has(`${r.transferId}\u0000${ownKind}`)) {
				result.unaudited.push({
					transferId: r.transferId,
					reason: `its audit write degraded, and its ${ownKind} event is not on the chain`,
				});
			}
			continue;
		}
		result.unaudited.push({
			transferId: r.transferId,
			reason: "its auditHash is not on the chain",
		});
	}
	return result;
}

/** The governed action kinds (`ActionKind`), complete: a kind added there must be added here. */
const ACTION_KINDS: Record<ActionKind, true> = {
	llm_call: true,
	tool_use: true,
	file_access: true,
	shell_command: true,
	api_request: true,
};

function isActionKind(kind: unknown): kind is ActionKind {
	return typeof kind === "string" && Object.hasOwn(ACTION_KINDS, kind);
}

function receiptsComplete(r: ReceiptCheck | undefined): boolean {
	return r === undefined || (r.unaudited.length === 0 && r.unreadable === 0);
}

function printReceiptCheck(r: ReceiptCheck | undefined): void {
	if (r === undefined) return;
	if (receiptsComplete(r)) {
		console.log(
			pc.green(`Receipts: ${r.checked} checked, each with its audit event on the chain.`),
		);
		return;
	}
	console.log(
		pc.red(
			`INCOMPLETE: ${r.unaudited.length} of ${r.checked} receipt(s) have no audit event on the chain${r.unreadable > 0 ? `, and ${r.unreadable} entr${r.unreadable === 1 ? "y is" : "ies are"} not a readable receipt` : ""}.`,
		),
	);
	for (const u of r.unaudited.slice(0, 10)) {
		console.log(pc.red(`  - ${scrubForTerminal(u.transferId)}: ${scrubForTerminal(u.reason)}`));
	}
	if (r.unaudited.length > 10) console.log(pc.red(`  (+${r.unaudited.length - 10} more)`));
}

function isComplete(d: ChainDeadLetters | ChainDeadLettersUnreadable): boolean {
	return !("unreadable" in d) && d.missing === 0;
}

/** The JSON form: what is missing, never the dead letters' payloads. */
function deadLettersJson(
	d: ChainDeadLetters | ChainDeadLettersUnreadable,
): Record<string, unknown> {
	if ("unreadable" in d) return { path: d.path, unreadable: d.unreadable };
	return {
		path: d.path,
		missing: d.missing,
		missingByKind: d.missingByKind,
		missingTransferIds: d.missingTransferIds,
		onChain: d.onChain,
	};
}

/** The human lines for an incomplete vault (nothing for a complete one). */
function printIncompleteness(d: ChainDeadLetters | ChainDeadLettersUnreadable): void {
	if ("unreadable" in d) {
		console.log(
			pc.red(
				`INCOMPLETE?: the dead-letter queue ${scrubForTerminal(d.path)} could not be read (${scrubForTerminal(d.unreadable)}), so whether audit events are missing from the chain is unknown.`,
			),
		);
		return;
	}
	if (d.missing === 0) return;
	console.log(pc.red(`INCOMPLETE: ${scrubForTerminal(describeMissingEvents(d))}.`));
	const shown = d.missingTransferIds.slice(0, 10).map(scrubForTerminal).join(", ");
	if (shown !== "") {
		const more = d.missingTransferIds.length - 10;
		console.log(
			pc.red(`  Transfers with no audit event: ${shown}${more > 0 ? ` (+${more} more)` : ""}`),
		);
	}
}

/**
 * A witness-attested time on its way to a terminal. The receipt parser bounds
 * integratedTime, but this value also arrives from library callers, and
 * `toISOString()` throws RangeError outside ±8.64e15 ms — printing raw
 * milliseconds beats crashing the verifier over a number it already distrusts.
 */
function formatAttestedMs(ms: number): string {
	return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : `${ms} ms`;
}

export async function run(rootDir?: string, opts?: CliOptions, args?: string[]): Promise<void> {
	const json = opts?.json === true;

	const fail = (message: string, code = 1): void => {
		if (json) {
			console.log(toSafeJson({ command: "verify", success: false, data: { message } }));
		} else {
			// Thrown messages echo argv (a flag name, a value, an unreadable path).
			console.log(pc.red(scrubForTerminal(message)));
		}
		process.exitCode = code;
	};

	let flags: AnchorFlags;
	try {
		flags = await parseAnchorFlags(args ?? process.argv.slice(2), args !== undefined);
	} catch (err) {
		fail(err instanceof Error ? err.message : String(err));
		return;
	}

	// An argument shape the command cannot honour: refuse, exit 2. Taking the first and ignoring
	// the rest would verify one vault while the operator asked about two.
	const dash = flags.dashTokens[0];
	if (dash !== undefined) {
		fail(
			`Unknown option "${scrubForTerminal(dash)}": usertrust verify has no short flags. A path that begins with "-" must be written ./${scrubForTerminal(dash)}.`,
			2,
		);
		return;
	}
	if (flags.targets.length > 1) {
		fail(
			`usertrust verify takes one path, got ${flags.targets.length}: ${flags.targets
				.map((t) => `"${scrubForTerminal(t)}"`)
				.join(", ")}.`,
			2,
		);
		return;
	}

	// A path that was GIVEN is verified or refused, never replaced by the cwd. Falling back turned
	// `usertrust verify <vault-a>` run inside vault-b into vault-b's chain presented as a verdict
	// on vault-a.
	const given = flags.targets[0];
	if (given === "") {
		// resolve("") is the cwd: an empty argument must not become the silent fallback.
		fail("usertrust verify: the path is empty.", 2);
		return;
	}
	// The OS resolves a path ONCE, natively, and everything after is built from that physical
	// directory. `path.resolve`/`join` collapse `..` LEXICALLY, but the OS applies `..` after it has
	// followed the link before it: `work/link/../vault` with `link -> other/subdir` is
	// `other/vault`, and normalising first named `work/vault`, a PASS for a different chain. So
	// nothing here normalises a path that can still hold a link; a relative argument is
	// concatenated onto the cwd, not resolved against it.
	const raw = rootDir ?? given ?? process.cwd();
	const absolute = isAbsolute(raw) ? raw : `${process.cwd()}${sep}${raw}`;
	let root = absolute;
	if (given !== undefined && rootDir === undefined) {
		const shown = scrubForTerminal(absolute);
		let isDir = false;
		try {
			isDir = statSync(absolute).isDirectory();
		} catch {
			// missing, or a directory we cannot traverse: same refusal
		}
		if (!isDir) {
			fail(`Cannot verify ${shown}: not a directory.`);
			return;
		}
		root = realpathSync.native(absolute);
		if (!existsSync(join(root, VAULT_DIR))) {
			// `.usertrust` itself is the likeliest wrong argument: say what to pass instead of
			// guessing. The vault is the project root's, and so is every other command's.
			fail(
				basename(root) === VAULT_DIR
					? `No trust vault found at ${shown}: pass the project root ${scrubForTerminal(dirname(root))}, not the ${VAULT_DIR} directory.`
					: `No trust vault found at ${shown}. Run \`usertrust init\` there first.`,
			);
			return;
		}
	} else {
		try {
			root = realpathSync.native(absolute);
		} catch {
			// not there: the missing-vault answer below says so
		}
	}
	const vaultPath = join(root, VAULT_DIR);
	warnIfVaultLoose(vaultPath);

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				toSafeJson({
					command: "verify",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		// A missing vault is a failed verification for CI purposes.
		process.exitCode = 1;
		return;
	}

	// Name the vault the verdict is about, by the directory actually read: a symlinked argument
	// shows its target. Resolved after the existence checks, so it cannot throw on a missing path.
	// The `.usertrust` itself can be a symlink to another vault, so resolve IT, not just the
	// project directory: the subject named is the vault actually read.
	let verifiedVault: string;
	try {
		verifiedVault = realpathSync.native(join(root, VAULT_DIR));
	} catch {
		fail(`No trust vault found at ${scrubForTerminal(root)}.`);
		return;
	}
	if (!json) console.log(`Vault: ${scrubForTerminal(verifiedVault)}`);

	const verifiedAt = new Date().toISOString();

	if (flags.anchorMode) {
		const { result, events } = verifyVaultWithAnchorsReading(verifiedVault, flags.params);
		const deadLetters = deadLettersAgainst(verifiedVault, events);
		const receipts =
			flags.receiptsRaw.length > 0 ? checkReceipts(events, flags.receiptsRaw) : undefined;
		const complete = isComplete(deadLetters) && receiptsComplete(receipts);
		const anchoredExit = exitCodeForAnchored(result, {
			requireAnchor: flags.requireAnchor,
			requireExternalAnchor: flags.requireExternalAnchor,
		});
		// Exit codes stay 0/1 (constraints §4.3): an incomplete vault fails like an invalid one.
		const exitCode = anchoredExit !== 0 ? anchoredExit : complete ? 0 : 1;
		if (json) {
			console.log(
				toSafeJson({
					command: "verify",
					// `success` IS the exit code — one verdict. `result.valid && complete` ignored the
					// anchored gates (--require-anchor, --require-external-anchor), so an UNANCHORED vault under
					// --require-anchor printed `success: true` while the process exited 1, and a machine reader of
					// the JSON saw a pass the exit code refused.
					success: exitCode === 0,
					data: {
						valid: result.valid,
						complete,
						deadLetters: deadLettersJson(deadLetters),
						...(receipts !== undefined ? { receipts } : {}),
						chainLength: result.chainLength,
						errors: result.errors,
						merkleRoot: result.merkleRoot,
						anchorState: result.anchorState,
						anchoring: result.anchoring,
						vaultPath: verifiedVault,
						verifiedAt,
					},
				}),
			);
			if (exitCode !== 0) process.exitCode = exitCode;
			return;
		}
		if (result.valid) {
			console.log(pc.green(`Chain verified: ${result.chainLength} events, all hashes valid.`));
		} else {
			console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
			for (const err of result.errors) {
				console.log(pc.red(`  - ${scrubForTerminal(err)}`));
			}
		}
		printIncompleteness(deadLetters);
		printReceiptCheck(receipts);
		console.log(`Anchor state: ${result.anchorState} (source: ${result.anchoring.anchorSource})`);
		if (result.anchoring.latestAnchor) {
			const la = result.anchoring.latestAnchor;
			console.log(`Latest anchor: #${la.anchorSeq} treeSize ${la.treeSize} (${la.timestamp})`);
		}
		console.log(`Unanchored tail: ${result.anchoring.unanchoredTail.events} event(s)`);
		const rekor = result.anchoring.rekor;
		if (rekor !== undefined) {
			const attested =
				rekor.latestAttestedTimeMs === null
					? ""
					: `, attested ${formatAttestedMs(rekor.latestAttestedTimeMs)}`;
			const failed = rekor.receiptsFailed > 0 ? `, ${rekor.receiptsFailed} FAILED` : "";
			console.log(`Rekor: ${rekor.receiptsVerified} receipt(s) verified${failed}${attested}`);
		}
		if (result.anchoring.anchorSource === "vault-mirror") {
			console.log(
				pc.yellow(
					"WARNING: anchors verified from the vault-local mirror only — supply an externally fetched copy for deletion protection.",
				),
			);
		}
		for (const w of result.anchoring.warnings) {
			console.log(pc.yellow(`WARNING: ${w}`));
		}
		console.log(pc.dim(`Verified at: ${verifiedAt}`));
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}

	// Integrity AND completeness, one function shared with `usertrust report` (audit/complete.ts).
	const {
		reading: { result, events },
		deadLetters,
	} = verifyVaultComplete(verifiedVault);
	const receipts =
		flags.receiptsRaw.length > 0 ? checkReceipts(events, flags.receiptsRaw) : undefined;
	const complete = isComplete(deadLetters) && receiptsComplete(receipts);

	if (json) {
		console.log(
			toSafeJson({
				command: "verify",
				success: result.valid && complete,
				data: {
					valid: result.valid,
					complete,
					deadLetters: deadLettersJson(deadLetters),
					...(receipts !== undefined ? { receipts } : {}),
					chainLength: result.chainLength,
					errors: result.errors,
					merkleRoot: result.merkleRoot,
					anchorState: "UNANCHORED",
					vaultPath: verifiedVault,
					verifiedAt,
				},
			}),
		);
		if (!result.valid || !complete) process.exitCode = 1;
		return;
	}

	if (!complete) process.exitCode = 1;
	if (result.valid) {
		console.log(pc.green(`Chain verified: ${result.chainLength} events, all hashes valid.`));
		printIncompleteness(deadLetters);
		printReceiptCheck(receipts);
		if (result.merkleRoot) console.log(`Merkle root: ${pc.dim(result.merkleRoot)}`);
		console.log(
			pc.dim(
				"Anchor state: UNANCHORED — internal consistency only; supply --anchor + --pubkey for independent verification.",
			),
		);
	} else {
		console.log(pc.red(`Chain verification FAILED: ${result.errors.length} error(s) found.`));
		console.log(`Events checked: ${result.chainLength}`);
		for (const err of result.errors) {
			console.log(pc.red(`  - ${scrubForTerminal(err)}`));
		}
		printIncompleteness(deadLetters);
		printReceiptCheck(receipts);
		// Use process.exitCode (not process.exit) so buffered stdout flushes.
		process.exitCode = 1;
	}

	console.log(pc.dim(`Verified at: ${verifiedAt}`));
}
