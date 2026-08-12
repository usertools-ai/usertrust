// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust health — Show entropy diagnostics
 *
 * Uses entropy.ts to compute 6-signal health score from audit events.
 * Displays per-signal breakdown with status indicators.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
	computeEntropyScore,
	type EntropyEventInput,
	type EntropyLevel,
} from "../audit/entropy.js";
import { verifyChain } from "../audit/verify.js";
import { validatePolicyFile } from "../policy/gate.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import type { CliOptions } from "./init.js";
import { DEFAULT_POLICIES_PATH, resolvePolicyPath } from "./policy-path.js";

function loadEvents(vaultPath: string): AuditEvent[] {
	const logPath = join(vaultPath, "audit", "events.jsonl");
	if (!existsSync(logPath)) return [];

	try {
		const content = readFileSync(logPath, "utf-8").trim();
		if (!content) return [];

		return content
			.split("\n")
			.filter((l) => l.trim())
			.map((line) => JSON.parse(line) as AuditEvent);
	} catch {
		return [];
	}
}

/**
 * Strip control characters from untrusted text before it reaches a terminal.
 *
 * Policy-file content is operator-authored but not necessarily trusted — an
 * issue message can quote a key name straight out of the document. AGENTS.md
 * requires sanitising BEFORE clipping, since a half-clipped escape is still an
 * escape. Mirrors `CONTROL_CHARS`/`clipKey` in `cli/verify.ts`.
 */
/**
 * Make untrusted text safe to echo to a terminal.
 *
 * Covers C0 AND C1 (0x80-0x9f), the range holding the 8-bit CSI/OSC introducers
 * — a terminal honouring those can be repainted by a string the common
 * C0-only regex passes through untouched. AGENTS.md records why `budget.ts`'s
 * `forDisplay` is deliberately stronger than the other copies and must not be
 * unified down onto them; this path has the same property (it echoes argv and
 * config-supplied text), so it takes the strong form rather than adding another
 * weak one. Substitutes rather than strips, so removing a byte cannot close two
 * fragments into a plausible whole, and clips AFTER substituting.
 */
function scrubForTerminal(text: string, max = 200): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) as number;
		out += code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? "?" : ch;
	}
	return out.length > max ? `${out.slice(0, max)}...` : out;
}

/**
 * What the policy file would actually contribute to a governed call.
 *
 * `health` reported policy VIOLATIONS and nothing else, and `coloredTag()`
 * renders zero hits as a green `[ok]`. A vault with no loaded rules and a vault
 * with a fully satisfied policy were therefore indistinguishable on that line.
 * Reporting how many rules actually LOAD — and how many are enabled — is what
 * distinguishes "nothing was violated" from "nothing was enforced".
 */
function loadPolicyStatus(vaultPath: string): {
	/** null when the config could not be resolved — there is no target to name. */
	path: string | null;
	/** Set only when the failure is the CONFIG rather than the policy file. */
	configError?: string;
	present: boolean;
	rules: number;
	active: number;
	issues: number;
	firstIssue: string | undefined;
} {
	// Shared with `cli/policy.ts` — see policy-path.ts. A config that cannot be
	// read is reported, not replaced with the default: validating
	// ./policies/default.yml and printing [ok] for a deployment whose config the
	// governor rejects is a green light for a vault that cannot start.
	const resolved = resolvePolicyPath(vaultPath);
	if ("error" in resolved) {
		// No policy target was resolved, so there is no path to report and nothing
		// whose presence could be asserted. Naming the DEFAULT here attributed the
		// failure to `policies/default.yml` — a file that may be perfectly fine and
		// that the governor will never reach — and `present: true` claimed it had
		// been looked at. The config is the subject of this failure; say so.
		return {
			path: null,
			configError: resolved.error,
			present: false,
			rules: 0,
			active: 0,
			issues: 1,
			firstIssue: resolved.error,
		};
	}
	const rel = resolved.path;
	const path = join(vaultPath, rel);
	// No `existsSync` preflight — see validatePolicyFile. An absent file yields no
	// issues and no rules, which is what `present: false` means here; anything
	// else is a real problem and must not read as "no policy file".
	const { rules, issues, present } = validatePolicyFile(path);
	if (!present) {
		return { path, present: false, rules: 0, active: 0, issues: 0, firstIssue: undefined };
	}
	// `enabled: false` rules load and are then skipped by `ruleMatches`, so a file
	// of nothing but disabled rules is loaded-but-inert. Counting those as live
	// would reproduce, one level along, exactly the confusion this line exists to
	// remove: a green count next to no enforcement.
	const active = rules.filter((r) => r.enabled !== false).length;
	return {
		path,
		present: true,
		rules: rules.length,
		active,
		issues: issues.length,
		// RAW on purpose. Scrubbing here would substitute and clip BEFORE the output
		// mode is chosen, so `--json` would report a corrupted diagnostic that
		// `toSafeJson` cannot restore. The human branch scrubs where it prints;
		// escaping and scrubbing are not interchangeable.
		firstIssue: issues[0] === undefined ? undefined : `${issues[0].at}: ${issues[0].message}`,
	};
}

/**
 * Serialise with C1 escaped.
 *
 * The scrubber above is for HUMAN output: it substitutes and clips, which is
 * right for a terminal and wrong for a machine-readable field — a consumer needs
 * the real value back. So JSON escapes rather than substitutes, and nothing on
 * the `--json` path is clipped.
 */
function toSafeJson(value: unknown): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the intent
	return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (c) => {
		const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
		return `\\u${hex}`;
	});
}

function loadConfig(vaultPath: string): { budget: number } {
	const configPath = join(vaultPath, "usertrust.config.json");
	if (!existsSync(configPath)) return { budget: 0 };

	try {
		const raw = readFileSync(configPath, "utf-8");
		const config = JSON.parse(raw) as { budget?: number };
		return { budget: typeof config.budget === "number" ? config.budget : 0 };
	} catch {
		return { budget: 0 };
	}
}

function levelLabel(level: EntropyLevel): string {
	switch (level) {
		case "low":
			return "healthy";
		case "elevated":
			return "elevated";
		case "critical":
			return "critical";
	}
}

function coloredLevel(level: EntropyLevel): string {
	switch (level) {
		case "low":
			return pc.green("healthy");
		case "elevated":
			return pc.yellow("elevated");
		case "critical":
			return pc.red("critical");
	}
}

function statusTag(value: number, hits: number): string {
	if (hits === 0) return "[ok]";
	if (value < 0.3) return "[low]";
	if (value < 0.6) return "[elevated]";
	return "[critical]";
}

function coloredTag(value: number, hits: number): string {
	if (hits === 0) return pc.green("[ok]");
	if (value < 0.3) return pc.green("[low]");
	if (value < 0.6) return pc.yellow("[elevated]");
	return pc.red("[critical]");
}

export async function run(rootDir?: string, opts?: CliOptions): Promise<void> {
	const root = rootDir ?? process.cwd();
	const vaultPath = join(root, VAULT_DIR);
	const json = opts?.json === true;

	if (!existsSync(vaultPath)) {
		if (json) {
			console.log(
				toSafeJson({
					command: "health",
					success: false,
					data: { message: "No trust vault found. Run `usertrust init` first." },
				}),
			);
		} else {
			console.log(`${pc.red("No trust vault found.")} Run \`usertrust init\` first.`);
		}
		return;
	}

	const events = loadEvents(vaultPath);
	const config = loadConfig(vaultPath);
	const policyStatus = loadPolicyStatus(vaultPath);

	// Convert audit events to entropy event inputs
	const entropyEvents: EntropyEventInput[] = events.map((e) => ({
		kind: e.kind,
		data: e.data,
	}));

	// Verify chain integrity directly
	const logPath = join(vaultPath, "audit", "events.jsonl");
	const verification = verifyChain(logPath);
	const chainLabel = verification.valid ? "verified" : "FAILED";
	const chainStatus = verification.valid ? "[ok]" : "[critical]";

	// Compute budget utilization percentage
	let spent = 0;
	for (const e of events) {
		if (e.kind !== "llm_call") continue;
		const cost = e.data.cost;
		if (typeof cost === "number") {
			spent += cost;
		}
	}
	const budgetPct = config.budget > 0 ? ((spent / config.budget) * 100).toFixed(1) : "0.0";

	// BOTH facts are computed above and BOTH are passed in. Neither can be derived
	// from the event stream: no producer writes a budget total, and chain validity
	// is a property of the log rather than of any event in it. Until this call
	// carried them, those two signals abstained — so a tampered log or an
	// exhausted budget still left the headline level reading "healthy", which is
	// the exact failure the signal rewiring exists to remove.
	//
	// This is also why the ORDER changed: verification and spend used to be
	// computed AFTER the score that needed them.
	const report = computeEntropyScore(entropyEvents, {
		budget: { total: config.budget, spent },
		chain: { valid: verification.valid, errors: verification.errors },
	});

	// Signal values
	const policySignal = report.signals.find((s) => s.condition === "policy_violations");
	const policyHits = policySignal?.hits ?? 0;
	const piiSignal = report.signals.find((s) => s.condition === "pii_detections");
	const piiHits = piiSignal?.hits ?? 0;
	const cbSignal = report.signals.find((s) => s.condition === "circuit_breaker_trips");
	const cbHits = cbSignal?.hits ?? 0;
	const pmSignal = report.signals.find((s) => s.condition === "pattern_memory_hits");
	const pmHits = pmSignal?.hits ?? 0;

	if (json) {
		console.log(
			toSafeJson({
				command: "health",
				success: true,
				data: {
					score: report.score,
					level: levelLabel(report.level),
					policy: {
						path: policyStatus.path,
						...(policyStatus.configError !== undefined
							? { configError: policyStatus.configError }
							: {}),
						present: policyStatus.present,
						rulesLoaded: policyStatus.rules,
						rulesActive: policyStatus.active,
						issues: policyStatus.issues,
						...(policyStatus.firstIssue !== undefined
							? { firstIssue: policyStatus.firstIssue }
							: {}),
					},
					signals: {
						policyViolations: policyHits,
						budgetUtilization: Number.parseFloat(budgetPct),
						chainIntegrity: verification.valid,
						piiDetections: piiHits,
						// RENAMED to what they measure. `circuitBreakerTrips` counted no
						// breaker transition — no producer emits one — and reported an
						// anomaly abort as a trip; `patternMemoryHits` reported injection
						// detections even with pattern memory disabled. Both previously
						// always read 0, so nothing could depend on their values; a key
						// that names the wrong thing is worse than one that moved.
						anomalyAborts: cbHits,
						injectionMatches: pmHits,
					},
				},
			}),
		);
		return;
	}

	console.log(`Entropy score: ${report.score}/100 (${coloredLevel(report.level)})`);

	// The policy PATH is config-supplied (`policies` in usertrust.config.json), so
	// it is untrusted text on a terminal exactly like an issue message. Bound once
	// here and used for every human-rendered branch below, rather than scrubbed at
	// each print site — the JSON payload above keeps the raw value, since escaping
	// is a rendering concern and truncating there would corrupt the field.
	const safePath = policyStatus.path === null ? null : scrubForTerminal(policyStatus.path);

	// Signal 0: what the policy file actually contributes. This line comes FIRST
	// on purpose — a violation count is only meaningful once you know how many
	// rules were in a position to be violated.
	if (policyStatus.configError !== undefined) {
		// The CONFIG failed, so no policy file was ever identified. Naming one here
		// would point the operator at a file that is probably fine.
		console.log(
			`  Policy rules loaded:      0    ${pc.red("[CONFIG]")} ${scrubForTerminal(policyStatus.configError)}`,
		);
		console.log(
			`${pc.red("      The governor resolves its policy path from this file, so it will not start.")}`,
		);
	} else if (!policyStatus.present) {
		console.log(
			`  Policy rules loaded:      0    ${pc.yellow("[none]")} no policy file at ${safePath} — built-in budget rules only`,
		);
	} else if (policyStatus.issues > 0) {
		console.log(
			`  Policy rules loaded:      0    ${pc.red("[INVALID]")} ${policyStatus.issues} problem(s) in ${safePath}`,
		);
		if (policyStatus.firstIssue !== undefined) {
			console.log(`${pc.red(`      first: ${scrubForTerminal(policyStatus.firstIssue)}`)}`);
		}
		console.log(
			`${pc.red("      NONE of this file's rules are enforced. Run `usertrust policy validate`.")}`,
		);
	} else if (policyStatus.rules === 0) {
		console.log(
			`  Policy rules loaded:      0    ${pc.yellow("[empty]")} file is valid but declares no rules`,
		);
	} else if (policyStatus.active === 0) {
		console.log(
			`  Policy rules loaded:      ${policyStatus.rules}    ${pc.yellow("[inert]")} all ${policyStatus.rules} are \`enabled: false\` — none can fire`,
		);
	} else if (policyStatus.active < policyStatus.rules) {
		console.log(
			`  Policy rules loaded:      ${policyStatus.active}/${policyStatus.rules} active    ${pc.green("[ok]")}`,
		);
	} else {
		console.log(`  Policy rules loaded:      ${policyStatus.rules}    ${pc.green("[ok]")}`);
	}

	// Signal 1: Policy violations
	const policyTag = coloredTag(policySignal?.value ?? 0, policyHits);
	console.log(`  Policy violations (30d):  ${policyHits}   ${policyTag}`);

	// Signal 2: Budget utilization
	const budgetStatus =
		Number.parseFloat(budgetPct) > 80 ? pc.yellow("[elevated]") : pc.green("[ok]");
	console.log(`  Budget utilization:      ${budgetPct}% ${budgetStatus}`);

	// Signal 3: Chain integrity
	const chainColored = verification.valid
		? pc.green(`${chainLabel} ${chainStatus}`)
		: pc.red(`${chainLabel} ${chainStatus}`);
	console.log(`  Chain integrity:         ${chainColored}`);

	// Signal 4: PII detections
	const piiStatus = coloredTag(piiSignal?.value ?? 0, piiHits);
	console.log(`  PII detections (30d):    ${piiHits}   ${piiStatus}`);

	// Signals 5 and 6 take their label FROM THE SIGNAL rather than repeating it
	// here. The two had drifted: the extractors were rewired to count anomaly
	// aborts and injection matches while these lines still said "Circuit breaker
	// trips" and "Pattern memory hits", so the display named one thing and
	// measured another. Reading `signal.label` means a future rewiring cannot
	// leave the caption behind.
	const cbStatus = coloredTag(cbSignal?.value ?? 0, cbHits);
	console.log(`  ${(cbSignal?.label ?? "Anomaly aborts").padEnd(24)} ${cbHits}   ${cbStatus}`);

	const pmStatus = coloredTag(pmSignal?.value ?? 0, pmHits);
	console.log(`  ${(pmSignal?.label ?? "Injection matches").padEnd(24)} ${pmHits}   ${pmStatus}`);
}
