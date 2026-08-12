// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Terminal receipt renderer for single-transaction verification.
 * Renders a thermal-printer-style receipt using box-drawing characters.
 *
 * ZERO DEPENDENCIES — Node built-ins only.
 */

// ── Types ──

export interface TransactionEvent {
	readonly id: string;
	readonly timestamp: string;
	readonly previousHash: string;
	readonly kind: string;
	readonly actor: string;
	readonly data: {
		readonly model?: string;
		readonly cost?: number;
		readonly settled?: boolean;
		readonly error?: string;
		/** The anomaly detector's reason — `anomaly_detected` writes `message`, not `error`. */
		readonly message?: string;
		readonly transferId: string;
	};
	readonly sequence: number;
	readonly hash: string;
}

export interface ReceiptData {
	readonly event: TransactionEvent;
	readonly chainLength: number;
	readonly merkleRoot: string;
	readonly merkleVerified: boolean;
	readonly chainVerified: boolean;
	readonly cumulativeSpend: number;
	readonly verifiedAt: Date;
	/**
	 * Honest Merkle-row label. "INCLUSION VERIFIED" may ONLY be passed when
	 * the proof was checked against a verified EXTERNAL anchor root — never
	 * from a root recomputed out of the same events (the retired F1 path).
	 * Absent → the truthful unanchored default is rendered.
	 */
	readonly merkleLabel?: string | undefined;
}

// ── Formatting helpers ──

const WIDTH = 45; // internal content width (between │ borders)

function pad(text: string, width: number = WIDTH): string {
	if (text.length >= width) return text.slice(0, width);
	return text + " ".repeat(width - text.length);
}

function center(text: string, width: number = WIDTH): string {
	if (text.length >= width) return text.slice(0, width);
	const left = Math.floor((width - text.length) / 2);
	const right = width - text.length - left;
	return " ".repeat(left) + text + " ".repeat(right);
}

function line(left: string, right: string, width: number = WIDTH): string {
	const gap = width - left.length - right.length;
	if (gap < 1) return `${left} ${right}`.slice(0, width);
	return left + " ".repeat(gap) + right;
}

function dotted(label: string, value: string, width: number = WIDTH): string {
	const minDots = 2;
	const gap = width - label.length - value.length;
	if (gap < minDots + 2) return line(label, value, width);
	return `${label} ${".".repeat(gap - 2)} ${value}`;
}

function row(content: string): string {
	return `│${pad(content)}│`;
}

function divider(ch = "─"): string {
	return `│  ${ch.repeat(WIDTH - 4)}  │`;
}

function blank(): string {
	return row(" ".repeat(WIDTH));
}

function top(): string {
	return `┌${"─".repeat(WIDTH)}┐`;
}

function bottom(): string {
	return `└${"─".repeat(WIDTH)}┘`;
}

// ── Date formatting ──

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(iso: string): string {
	const d = new Date(iso);
	const mon = MONTHS[d.getMonth()] ?? "???";
	const day = d.getDate();
	const year = d.getFullYear();
	let hours = d.getHours();
	const mins = d.getMinutes().toString().padStart(2, "0");
	const ampm = hours >= 12 ? "PM" : "AM";
	hours = hours % 12 || 12;
	return `${mon} ${day}, ${year}  ${hours}:${mins} ${ampm}`;
}

function formatDateObj(d: Date): string {
	const mon = MONTHS[d.getMonth()] ?? "???";
	const day = d.getDate();
	const year = d.getFullYear();
	let hours = d.getHours();
	const mins = d.getMinutes().toString().padStart(2, "0");
	const ampm = hours >= 12 ? "PM" : "AM";
	hours = hours % 12 || 12;
	return `${mon} ${day}, ${year}  ${hours}:${mins} ${ampm}`;
}

// ── USD conversion ──
// 1 UT = $0.0001 (one basis point of a cent)
const UT_TO_USD = 0.0001;

function formatUsd(ut: number): string {
	const usd = ut * UT_TO_USD;
	if (usd < 0.01) return `$${usd.toFixed(4)}`;
	return `$${usd.toFixed(2)}`;
}

// ── Word wrap ──

function wordWrap(text: string, maxWidth: number): string[] {
	const result: string[] = [];
	const words = text.split(/\s+/);
	let current = "";

	for (const word of words) {
		if (current.length === 0) {
			current = word;
		} else if (current.length + 1 + word.length <= maxWidth) {
			current += ` ${word}`;
		} else {
			result.push(current);
			current = word;
		}
		// Handle words longer than maxWidth — hard break them
		while (current.length > maxWidth) {
			result.push(current.slice(0, maxWidth));
			current = current.slice(maxWidth);
		}
	}
	if (current.length > 0) {
		result.push(current);
	}
	return result.length > 0 ? result : [""];
}

// ── Terminal safety ──

/**
 * Scrub control characters out of an untrusted string before it is printed.
 *
 * EVERY string on this receipt comes out of `events.jsonl` — a file owned by
 * the party under audit — and lands on the terminal of the auditor running
 * `usertrust-verify --tx`. An escape sequence in any of them repaints the
 * screen the verdict is printed on, which forges a passing verification: the
 * entire product of a verification tool. `model` is the sharpest edge, because
 * the unknown-model denial copies a CALLER-SUPPLIED model string into the
 * event's `error` text, so it reaches here through two fields at once.
 *
 * This is the STRONGER of the repo's two sanitizer variants — the `forDisplay`
 * shape from `core/src/cli/budget.ts`, not the six-copy
 * `/[\x00-\x1f\x7f]/g` strip. It also covers C1 (0x80–0x9f), which holds the
 * 8-bit CSI and OSC introducers the narrower regex misses, and it SUBSTITUTES
 * rather than deletes so a scrubbed byte stays visible as evidence instead of
 * silently closing up. Duplicated rather than imported because this package is
 * the independent zero-dependency verifier and may not import from core; see
 * the sanitizer inventory in AGENTS.md, which forbids consolidating these onto
 * the weaker variant.
 */
function forDisplay(raw: string): string {
	let out = "";
	for (const ch of raw) {
		const code = ch.codePointAt(0) as number;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out;
}

// ── Hash formatting ──

function truncHash(hash: string, len = 8): string {
	if (hash.length <= len * 2 + 3) return hash;
	return `${hash.slice(0, len)}...${hash.slice(-len)}`;
}

// ── Provider detection ──

function detectProvider(model: string): string {
	if (model.startsWith("claude")) return "anthropic";
	if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
	if (model.startsWith("gemini")) return "google";
	if (model.startsWith("command")) return "cohere";
	if (model.startsWith("mistral") || model.startsWith("mixtral")) return "mistral";
	return "unknown";
}

// ── Status ──

/**
 * A governance denial writes a chain event carrying a `transferId`, so
 * `verifyTransaction` selects it by id like any other event. Without DENIED,
 * the renderer falls through to the `settled !== true` default and prints
 * PENDING for a call that was REFUSED and will never settle — a receipt
 * asserting the opposite of what the chain records.
 */
const DENIAL_KINDS = new Set(["policy_denied", "ledger_rejected"]);

/**
 * An anomaly abort is the SAME defect class DENIED was added to fix, one step
 * further along: the anomaly detector tripped mid-stream, the governor voided
 * the hold, and the call died. It reaches here for two reasons that compound —
 * `anomaly_detected` carries the call's `transferId`, and `verifyTransaction`
 * selects the FIRST event matching that id, while an aborted stream never gets
 * as far as writing an `llm_call`. So the anomaly event IS the receipt's
 * subject.
 *
 * It carries no `settled` field, so without this arm it fell through to the
 * `settled !== true` default and printed PENDING — "may still settle" for a
 * call that was killed and never will.
 *
 * ABORTED rather than DENIED on purpose: a denial is a governance decision made
 * BEFORE the provider was called and nothing was spent, whereas an anomaly
 * abort interrupted a call already in flight, which may have consumed tokens
 * the void returned. Collapsing the two would tell an auditor a killed call was
 * refused.
 */
const ABORT_KINDS = new Set(["anomaly_detected"]);

function resolveStatus(event: TransactionEvent): string {
	if (DENIAL_KINDS.has(event.kind)) return "DENIED";
	if (ABORT_KINDS.has(event.kind)) return "ABORTED";
	if (event.kind === "llm_call_failed") return "FAILED";
	if (event.data.settled === true) return "SETTLED";
	return "PENDING";
}

// ── Receipt renderer ──

export function renderReceipt(data: ReceiptData): string {
	const {
		event,
		chainLength,
		merkleRoot,
		merkleVerified,
		chainVerified,
		cumulativeSpend,
		verifiedAt,
	} = data;
	const status = resolveStatus(event);
	// `detectProvider` matches on the RAW value — scrubbing first would let a
	// leading control character hide a real provider prefix and mislabel the
	// row. Only the rendered copy is scrubbed.
	const model = event.data.model ?? "unknown";
	const provider = detectProvider(model);
	const cost = event.data.cost;
	const isFailed = event.kind === "llm_call_failed";
	// A denial spent nothing, so it renders no spend lines — but its `error` is
	// the whole point of the receipt and must still be shown.
	const isDenied = DENIAL_KINDS.has(event.kind);
	// An anomaly abort voided its hold, so it settled nothing and shows no spend
	// either. Its reason arrives as `message` rather than `error` — the field the
	// anomaly producer writes (`govern.ts:2077`) — so the reason block reads both.
	const isAborted = ABORT_KINDS.has(event.kind);
	const reason = event.data.error ?? (isAborted ? event.data.message : undefined);
	const allVerified = chainVerified && merkleVerified;

	const lines: string[] = [];

	// ── Header ──
	lines.push(top());
	lines.push(blank());
	lines.push(row(center("U S E R T R U S T")));
	lines.push(row(center("usertrust.ai")));
	lines.push(blank());

	// ── Transaction details ──
	lines.push(row(pad("  TRANSACTION RECEIPT")));
	lines.push(divider());
	lines.push(row(`${dotted("  TX", forDisplay(event.data.transferId), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Date", forDisplay(formatDate(event.timestamp)), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Model", forDisplay(model), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Provider", provider, WIDTH - 1)} `));

	if (!isFailed && !isDenied && !isAborted && cost !== undefined) {
		lines.push(row(`${dotted("  Spend", `${cumulativeSpend} UT`, WIDTH - 1)} `));
		lines.push(row(`${dotted("  Conversion", formatUsd(cumulativeSpend), WIDTH - 1)} `));
	}

	lines.push(row(`${dotted("  Status", status, WIDTH - 1)} `));

	if ((isFailed || isDenied || isAborted) && reason) {
		lines.push(blank());
		// "Aborted:" rather than "Error:" — the anomaly detector doing its job is
		// not a fault, and labelling a working control as an error is how an
		// operator learns to ignore it.
		const errPrefix = isAborted ? "  Aborted: " : "  Error: ";
		const indent = " ".repeat(errPrefix.length);
		const maxW = WIDTH - indent.length - 2;
		const wrapped = wordWrap(forDisplay(reason), maxW);
		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? errPrefix : indent;
			lines.push(row(pad(`${prefix}${wrapped[i] as string}`)));
		}
	}

	lines.push(blank());

	// ── Chain verification ──
	lines.push(row(pad("  CHAIN VERIFICATION")));
	lines.push(divider());
	lines.push(
		row(`${dotted("  Position", `Event ${event.sequence} of ${chainLength}`, WIDTH - 1)} `),
	);
	lines.push(row(`${dotted("  Hash", forDisplay(truncHash(event.hash)), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Prev", forDisplay(truncHash(event.previousHash)), WIDTH - 1)} `));

	// AC-5.3: without an external anchor the truthful claim is chain
	// consistency, not inclusion — the old unconditional "INCLUSION VERIFIED"
	// came from a self-referential proof and is retired.
	const merkleStatus =
		data.merkleLabel ?? (merkleVerified ? "CHAIN CONSISTENT (UNANCHORED)" : "INCLUSION FAILED");
	lines.push(row(`${dotted("  Merkle", merkleStatus, WIDTH - 1)} `));

	lines.push(blank());

	// ── Verdict ──
	if (allVerified) {
		lines.push(row(center("* VERIFIED *")));
	} else {
		const reasons: string[] = [];
		if (!chainVerified) reasons.push("chain");
		if (!merkleVerified) reasons.push("merkle");
		lines.push(row(center(`FAILED (${reasons.join(", ")})`)));
	}

	lines.push(blank());

	// ── Footer ──
	lines.push(divider());
	lines.push(row(`${dotted("  Root", truncHash(merkleRoot), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Verified", formatDateObj(verifiedAt), WIDTH - 1)} `));
	lines.push(blank());
	lines.push(bottom());

	return lines.join("\n");
}

// ── Not-found renderer ──

export function renderNotFound(txId: string): string {
	const lines: string[] = [];
	lines.push(top());
	lines.push(blank());
	lines.push(row(center("U S E R T R U S T")));
	lines.push(row(center("usertrust.ai")));
	lines.push(blank());
	lines.push(divider());
	lines.push(blank());
	lines.push(row(center("Transaction not found")));
	lines.push(blank());
	// argv, echoed back at the operator who typed it — and an agent may be the
	// one typing. Sanitize first, clip second: `pad` truncating at WIDTH is not
	// a defense, since an erase-line sequence is four characters.
	lines.push(row(pad(`  TX: ${forDisplay(txId)}`)));
	lines.push(blank());
	lines.push(row(pad("  No event with this transferId exists")));
	lines.push(row(pad("  in the audit chain.")));
	lines.push(blank());
	lines.push(divider());
	lines.push(blank());
	lines.push(bottom());
	return lines.join("\n");
}
