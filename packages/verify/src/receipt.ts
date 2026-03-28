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

function resolveStatus(event: TransactionEvent): string {
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
	const model = event.data.model ?? "unknown";
	const provider = detectProvider(model);
	const cost = event.data.cost;
	const isFailed = event.kind === "llm_call_failed";
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
	lines.push(row(`${dotted("  TX", event.data.transferId, WIDTH - 1)} `));
	lines.push(row(`${dotted("  Date", formatDate(event.timestamp), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Model", model, WIDTH - 1)} `));
	lines.push(row(`${dotted("  Provider", provider, WIDTH - 1)} `));

	if (!isFailed && cost !== undefined) {
		lines.push(row(`${dotted("  Spend", `${cumulativeSpend} UT`, WIDTH - 1)} `));
		lines.push(row(`${dotted("  Conversion", formatUsd(cumulativeSpend), WIDTH - 1)} `));
	}

	lines.push(row(`${dotted("  Status", status, WIDTH - 1)} `));

	if (isFailed && event.data.error) {
		lines.push(blank());
		const errPrefix = "  Error: ";
		const indent = " ".repeat(errPrefix.length);
		const maxW = WIDTH - indent.length - 2;
		const wrapped = wordWrap(event.data.error, maxW);
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
	lines.push(row(`${dotted("  Hash", truncHash(event.hash), WIDTH - 1)} `));
	lines.push(row(`${dotted("  Prev", truncHash(event.previousHash), WIDTH - 1)} `));

	const merkleStatus = merkleVerified ? "INCLUSION VERIFIED" : "INCLUSION FAILED";
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
	lines.push(row(pad(`  TX: ${txId}`)));
	lines.push(blank());
	lines.push(row(pad("  No event with this transferId exists")));
	lines.push(row(pad("  in the audit chain.")));
	lines.push(blank());
	lines.push(divider());
	lines.push(blank());
	lines.push(bottom());
	return lines.join("\n");
}
