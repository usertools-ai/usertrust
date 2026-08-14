// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust health — Show entropy diagnostics
 *
 * Uses entropy.ts to compute 6-signal health score from audit events.
 * Displays per-signal breakdown with status indicators.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import {
	computeEntropyScore,
	type EntropyEventInput,
	type EntropyLevel,
} from "../audit/entropy.js";
import { verifyVault } from "../audit/verify.js";
import { validatePolicyFile } from "../policy/gate.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { AuditEvent } from "../shared/types.js";
import type { CliOptions } from "./init.js";
import { DEFAULT_POLICIES_PATH, resolvePolicyPath } from "./policy-path.js";

/**
 * Load the vault's events — EVERY segment, and validated rather than asserted.
 *
 * Two defects, one root each, both the same shape as this branch's P1.
 *
 * THE LIVE SEGMENT IS NOT THE VAULT. Moving the chain check to `verifyVault`
 * fixed the integrity signal and left this loader reading `events.jsonl` alone,
 * so on a rotated vault every entropy signal would have been computed from
 * partial history and reported healthier than the truth — the same false OK the
 * P1 was about, in the function next door. Half a fix for a defect class is the
 * worst outcome available, because the remaining half is now covered by the
 * claim that the class was handled.
 *
 * A CAST IS NOT A VALIDATION. `JSON.parse(line) as AuditEvent` asserted a shape
 * onto bytes off disk; `AuditEvent.data` is required by the TYPE, which is a
 * claim about what the writer emits, not a guarantee about what a file contains.
 * An event without `data` — legacy, hand-written, truncated — crashed
 * `usertrust health` outright at `entropy.ts:236`. The type stated the rule and
 * the file was under no obligation to obey it.
 */
function loadEvents(vaultPath: string): AuditEvent[] {
	const auditDir = join(vaultPath, "audit");
	if (!existsSync(auditDir)) return [];

	const segments: string[] = [];
	const mainLog = join(auditDir, "events.jsonl");
	if (existsSync(mainLog)) segments.push(mainLog);
	try {
		for (const entry of readdirSync(auditDir).sort()) {
			if (entry.endsWith(".jsonl") && entry !== "events.jsonl") {
				segments.push(join(auditDir, entry));
			}
		}
	} catch {
		// Directory read failure — fall back to whatever was already found.
	}

	const events: (AuditEvent & { sequence?: number })[] = [];
	for (const segment of segments) {
		let content: string;
		try {
			content = readFileSync(segment, "utf-8").trim();
		} catch {
			continue;
		}
		if (!content) continue;
		for (const line of content.split("\n")) {
			if (!line.trim()) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			const record = parsed as Record<string, unknown>;
			if (typeof record.kind !== "string") continue;
			// `data` is defaulted, never invented: an absent one reads as no
			// signals, which is what an event carrying none actually means.
			const data =
				typeof record.data === "object" && record.data !== null
					? (record.data as Record<string, unknown>)
					: {};
			events.push({
				...(record as unknown as AuditEvent),
				data,
				...(typeof record.sequence === "number" ? { sequence: record.sequence } : {}),
			});
		}
	}

	// Order by the persisted global sequence when every event carries one, so a
	// rotated vault presents one chronological stream. Mixed presence keeps file
	// order rather than inventing an ordering across two different conventions.
	if (events.length > 0 && events.every((e) => typeof e.sequence === "number")) {
		events.sort((a, b) => (a.sequence as number) - (b.sequence as number));
	}
	return events;
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

/**
 * Cumulative SESSION spend, as the governor persists it.
 *
 * `spend-ledger.json` is what `createGovernor`/`trust` seed the session wallet
 * from, so it is the only number that answers how much of this session's budget
 * is gone. Returns `undefined` when it is absent or unreadable, so the caller can
 * abstain rather than report a fabricated figure — deliberately NOT throwing,
 * because `health` is a read-only diagnostic and must not refuse to run over a
 * ledger the governor itself would refuse to start on. It reports what it can
 * read and stays quiet about what it cannot.
 */
function loadPersistedSpend(vaultPath: string, anyAttempt: boolean): number | undefined {
	let raw: string;
	try {
		raw = readFileSync(join(vaultPath, "spend-ledger.json"), "utf-8");
	} catch (err) {
		// ENOENT is an honest zero ONLY on a vault that has never settled anything.
		// `persistSpendLedger`'s first write can fail while the governor catches the
		// error and settles the call anyway — so an absent ledger beside settled
		// calls is not a fresh vault, it is a LOST ledger, and reporting "0.0% [ok]"
		// for it is the same absent-versus-unreadable conflation this function
		// already fixed one case of.
		//
		// The chain cannot narrow it further: cost-center attribution lives in
		// `envelopeDebited`, which is internal to the governor and never reaches an
		// event, so a vault whose settled calls were ALL envelope-attributed would
		// genuinely have zero session spend and still reads as unknown here. That
		// is the fail-closed direction — "we cannot confirm zero" rather than a
		// confident zero we have no evidence for.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return anyAttempt ? undefined : 0;
		return undefined;
	}
	try {
		const parsed = JSON.parse(raw) as { budgetSpent?: unknown };
		const value = parsed.budgetSpent;
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	} catch {
		return undefined;
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

	// Verify the WHOLE VAULT, not the live segment.
	//
	// `verifyChain(logPath)` walks `events.jsonl` alone. On a ROTATED vault that
	// file's first event links to the previous segment rather than to genesis, and
	// `.meta.sequence` is global — so a perfectly valid continuous vault fails it.
	// Feeding that into the new critical floor would report CRITICAL on a healthy
	// chain the moment a vault had ever rotated: the fix for "a tampered chain
	// reads healthy" shipping "a healthy chain reads tampered", which is worse,
	// because a monitor that cries wolf gets muted and then the real signal is
	// gone too.
	//
	// `verifyVault` walks every segment as one chain. The two take DIFFERENT
	// arguments — a log path versus the `.usertrust` directory — which is the
	// distinction AGENTS.md flags as easy to get wrong, and I got it wrong by
	// reaching for the one already in hand.
	const verification = verifyVault(vaultPath);

	// SESSION spend comes from the persisted ledger, not from summing the log.
	//
	// Summing `llm_call.cost` was wrong in both directions at once: it INCLUDED
	// cost-center calls, which debit an envelope and deliberately never move
	// session `budgetSpent`, and it OMITTED governed-action costs, which are
	// written under the dynamic action kinds. So attributed traffic could exhaust
	// an untouched session budget on the display, and action-only traffic could
	// leave a spent one reading unused.
	//
	// `spend-ledger.json` is the number the governor actually seeds from, so it is
	// the only one that answers "how much of this session's budget is gone". When
	// it cannot be read, `spent` stays undefined and the entropy signal ABSTAINS
	// rather than scoring a fabricated denominator — the same rule the extractor
	// already applies to a missing total.
	// A settlement ATTEMPT is evidence that spend happened — not a settlement.
	//
	// I keyed this on `settled === true` and reproduced, in a different file, the
	// exact defect the receipt branch had just fixed: `settled` is a THREE-valued
	// field, and its `false` case is the interesting one. `budgetSpent` is
	// incremented BEFORE the provider POST, so a stream or headless failure leaves
	// real spend recorded against a chain that says `settled: false` or
	// `settlement_ambiguous`. If the first ledger write also failed, the old
	// predicate stayed false, an absent ledger read as a genuine zero, and health
	// printed "0.0% [ok]" over money that was actually spent.
	//
	// Ambiguity is the strongest case for "unknown", not the weakest: it means the
	// producer itself could not say whether the spend landed.
	const anyAttempt = events.some((e) => {
		const data = (e as { data?: Record<string, unknown> }).data;
		return (
			data?.settled !== undefined ||
			e.kind === "settlement_ambiguous" ||
			e.kind === "settlement_shortfall"
		);
	});
	const spent = loadPersistedSpend(vaultPath, anyAttempt);
	// UNKNOWN is not zero. A malformed, negative or unreadable `spend-ledger.json`
	// means an unknown amount has been spent, and rendering "0.0% [ok]" reported
	// the most reassuring possible answer to a question the tool could not answer
	// — the same shape as every defect this branch removes, in the branch that
	// removes them.
	const budgetKnown = config.budget > 0 && spent !== undefined;
	const budgetPct = budgetKnown ? (((spent as number) / config.budget) * 100).toFixed(1) : null;

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
		budget: { total: config.budget, spent: spent ?? Number.NaN },
		chain: { valid: verification.valid, errors: verification.errors },
	});

	// THE LINE AND THE HEADLINE READ THE SAME SIGNAL — not two computations of one
	// fact. My first attempt at this counted `settlement_ambiguous` EVENTS here
	// while the signal counts distinct TRANSFERS, so two ambiguous records for one
	// transfer would have disagreed; and an earlier version derived the tag from
	// the new condition and the COLOUR from `verification.valid`, which would have
	// printed `[critical]` in green. Every one of those is the same defect: one
	// verdict, two sources, no obligation to agree.
	const chainSignal = report.signals.find((s) => s.condition === "chain_integrity");
	const ambiguousTransfers = (chainSignal?.hits ?? 0) - (verification.valid ? 0 : 1);
	const chainLabel = !verification.valid
		? "FAILED"
		: ambiguousTransfers > 0
			? `verified, ${ambiguousTransfers} settlement${ambiguousTransfers === 1 ? "" : "s"} ambiguous`
			: "verified";
	const chainStatus = chainSignal?.critical === true ? "[critical]" : "[ok]";

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
						// null, not 0 — an unreadable ledger is unknown spend, and a
						// machine consumer must be able to tell that apart from a vault
						// that has genuinely spent nothing.
						budgetUtilization: budgetPct === null ? null : Number.parseFloat(budgetPct),
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
						// DEPRECATED ALIASES. `health --json` is a machine-readable
						// surface, so removing a key breaks parsers and schema
						// validators on upgrade regardless of the value it used to
						// carry — a validator asserting the key EXISTS fails even
						// though it only ever saw 0. Removal belongs in a breaking
						// release; the accurate names ship now beside the old ones.
						/** @deprecated renamed to `anomalyAborts` — no breaker transition is recorded. */
						circuitBreakerTrips: cbHits,
						/** @deprecated renamed to `injectionMatches` — unrelated to pattern memory. */
						patternMemoryHits: pmHits,
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
		budgetPct === null
			? pc.yellow("[unknown]")
			: Number.parseFloat(budgetPct) > 80
				? pc.yellow("[elevated]")
				: pc.green("[ok]");
	// TWO different unknowns, and naming the wrong one sends the operator to the
	// wrong file. A null percentage means either the DENOMINATOR is unusable (no
	// configured budget, or a malformed/non-positive one) or the NUMERATOR is
	// (an unreadable or lost ledger). Reporting "unreadable ledger" for a config
	// problem points at an artifact that may be perfectly fine.
	const budgetText =
		budgetPct !== null
			? `${budgetPct}%`
			: config.budget > 0
				? "unreadable ledger"
				: "no budget configured";
	console.log(`  Budget utilization:      ${budgetText} ${budgetStatus}`);

	// Signal 3: Chain integrity
	// Coloured from the STATUS, not from `verification.valid` — keying the colour
	// off a different condition than the tag would have printed `[critical]` in
	// green, which is the same contradiction this fixes one layer further down.
	const chainColored =
		chainStatus === "[ok]"
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
