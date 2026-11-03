// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust demo. What usertrust does, with no key, no network and no money.
 *
 * It runs in a temporary vault, never the project's, with `dryRun` (no ledger) and a pretend client
 * that has the shape of an Anthropic client and answers from memory. It makes three governed calls,
 * then one the PII rule refuses and one the budget refuses, checks the chain with the same verifier
 * `usertrust verify` runs, and names the command that opens the vault in the visual ledger. Every line
 * says that no AI was called and no money was spent.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyVaultComplete } from "../audit/complete.js";
import { trust } from "../govern.js";
import { formatReceipt, formatUsd } from "../receipt/format.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { TrustReceipt } from "../shared/types.js";
import type { CliOptions } from "./init.js";
import { scrubForTerminal, toSafeJson } from "./target.js";

/** Said at the start of every line the demo prints. */
export const DEMO_PREFIX = "demo: no AI was called, no money was spent";

/** The demo vault's whole budget, in usertokens: room for the three calls, then not for a large one. */
const DEMO_BUDGET_UT = 20;

/** A pretend Anthropic client: it has the shape trust() recognizes and answers from memory, never over a network. */
function pretendClient(): {
	messages: { create: (params: { model: string }) => Promise<unknown> };
} {
	return {
		messages: {
			create: async (params) => ({
				id: "msg_demo",
				type: "message",
				role: "assistant",
				model: params.model,
				content: [{ type: "text", text: "This is a pretend answer." }],
				usage: { input_tokens: 120, output_tokens: 40 },
			}),
		},
	};
}

export interface DemoResult {
	readonly ok: boolean;
	readonly vaultBase: string;
	readonly receipts: readonly TrustReceipt[];
	readonly refusals: readonly { readonly kind: "pii" | "budget"; readonly reason: string }[];
	readonly verified: {
		readonly valid: boolean;
		/** No audit event is missing from the chain (the dead-letter queue is empty and readable). */
		readonly complete: boolean;
		readonly chainLength: number;
		readonly merkleRoot: string | null;
	};
	readonly uiCommand: string;
}

/** This package's version: the demo names the visual ledger at the same version, since the two ship in step. */
function ownVersion(): string {
	// Parsed from the file, not `require()`d: the packages are ES modules (the same way `cli/ui.ts` reads a package.json).
	// `../../package.json` is the package root from both `src/cli/` and `dist/cli/`.
	const manifest = JSON.parse(
		readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
	) as { version: string };
	return manifest.version;
}

/** The first line of an error message, scrubbed for a terminal and cut to a sensible width. */
function reasonOf(err: unknown): string {
	const first = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
	return scrubForTerminal(first).slice(0, 200);
}

/** Runs the demo in a fresh temporary vault and returns what happened. Prints nothing. */
export async function runDemo(): Promise<DemoResult> {
	const vaultBase = mkdtempSync(join(tmpdir(), "usertrust-demo-"));
	const vaultDir = join(vaultBase, VAULT_DIR);
	mkdirSync(vaultDir, { recursive: true });
	writeFileSync(
		join(vaultDir, "usertrust.config.json"),
		JSON.stringify({ budget: DEMO_BUDGET_UT, pii: "block" }),
	);

	const client = (await trust(pretendClient(), { dryRun: true, vaultBase })) as unknown as {
		messages: {
			create: (params: unknown) => Promise<{ receipt: TrustReceipt }>;
		};
		destroy: () => Promise<void>;
	};
	const ask = (content: string, maxTokens: number) =>
		client.messages.create({
			model: "claude-haiku-4-5",
			max_tokens: maxTokens,
			messages: [{ role: "user", content }],
		});

	const receipts: TrustReceipt[] = [];
	const refusals: { kind: "pii" | "budget"; reason: string }[] = [];
	try {
		for (const n of [1, 2, 3]) receipts.push((await ask(`Say hello, number ${n}.`, 64)).receipt);
		try {
			await ask("My social security number is 123-45-6789.", 64);
		} catch (err) {
			refusals.push({ kind: "pii", reason: reasonOf(err) });
		}
		try {
			await ask("Write a very long essay.", 8192);
		} catch (err) {
			refusals.push({ kind: "budget", reason: reasonOf(err) });
		}
	} finally {
		await client.destroy();
	}

	// As `usertrust verify` does: the chain verifies AND no event is missing from it (a dead-lettered append still verifies).
	const reading = verifyVaultComplete(vaultDir);
	const verified = {
		valid: reading.valid,
		complete: reading.complete,
		chainLength: reading.reading.result.chainLength,
		merkleRoot: reading.reading.result.merkleRoot,
	};
	const ok =
		receipts.length === 3 &&
		refusals.length === 2 &&
		refusals[0]?.kind === "pii" &&
		refusals[1]?.kind === "budget" &&
		verified.valid;
	return {
		ok,
		vaultBase,
		receipts,
		refusals,
		verified,
		uiCommand: `npx usertrust-ui@${ownVersion()} ${shellWord(vaultBase)}`,
	};
}

/**
 * A path as one shell word, for the shell the command is printed for. A plain path is left as it is. Any other
 * is single-quoted, which is literal in a POSIX shell (an embedded quote is written `'\\''`) and in PowerShell (an
 * embedded quote is doubled), so `$(...)` and `$var` are never expanded. `cmd.exe` does not treat single quotes as
 * quoting, so on Windows the command is printed as a PowerShell one and labelled. The command is for a person to
 * paste, and a temporary directory's name can hold a space.
 */
export function shellWord(path: string, platform: string = process.platform): string {
	// A backslash is a path separator on Windows and an escape in a POSIX shell; `%` is expanded by cmd.exe.
	const plain = platform === "win32" ? /^[A-Za-z0-9_@+=:,./\\-]+$/ : /^[A-Za-z0-9_@%+=:,./-]+$/;
	if (plain.test(path)) return path;
	if (platform === "win32") return `'${path.replace(/'/g, "''")}'`;
	return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** The demo as lines, each one saying nothing was called and nothing was spent. */
export function demoLines(result: DemoResult): string[] {
	const say = (text: string): string[] => text.split("\n").map((line) => `${DEMO_PREFIX}: ${line}`);
	const out: string[] = [];
	out.push(
		...say(
			`a pretend AI client, in a temporary vault at ${scrubForTerminal(result.vaultBase)}, with a budget of ${DEMO_BUDGET_UT} usertokens (${formatUsd(DEMO_BUDGET_UT)}) and PII set to block`,
		),
	);
	result.receipts.forEach((receipt, i) => {
		out.push(...say(`call ${i + 1} of ${result.receipts.length}`));
		out.push(...say(formatReceipt(receipt)));
	});
	for (const refusal of result.refusals) {
		out.push(
			...say(
				refusal.kind === "pii"
					? `a call with a social security number in it was refused before it left: ${refusal.reason}`
					: `a call that would overspend the budget was refused before it left: ${refusal.reason}`,
			),
		);
	}
	out.push(
		...say(
			result.verified.valid
				? `the audit chain verifies and is complete: ${result.verified.chainLength} events, merkle root ${(result.verified.merkleRoot ?? "").slice(0, 12)}...`
				: result.verified.complete
					? "the audit chain did NOT verify"
					: "the audit chain is INCOMPLETE: an audit event is missing from it, or its dead-letter queue could not be read",
		),
	);
	out.push(
		...say(
			`see it in the visual ledger${process.platform === "win32" ? " (in PowerShell)" : ""}: ${scrubForTerminal(result.uiCommand)}`,
		),
	);
	return out;
}

export async function run(_rootDir?: string, opts?: CliOptions): Promise<void> {
	const result = await runDemo();
	if (!result.ok) process.exitCode = 1;
	if (opts?.json === true) {
		console.log(
			toSafeJson({
				command: "demo",
				success: result.ok,
				data: {
					notice: DEMO_PREFIX,
					vault: result.vaultBase,
					receipts: result.receipts,
					refusals: result.refusals,
					verified: result.verified,
					ui: result.uiCommand,
				},
			}),
		);
		return;
	}
	for (const line of demoLines(result)) console.log(line);
	if (!result.ok) console.error(`${DEMO_PREFIX}: the demo did not go as expected`);
}
