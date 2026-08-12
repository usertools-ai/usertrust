// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust policy validate — check the policy file before it matters.
 *
 * This command exists because its absence was the reason a whole class of
 * failure was uncatchable locally. `loadPolicies` used to answer a tab
 * character, a wrong indent, a trailing comma, or a top-level key of
 * `policies:` with an empty rule set and no error, so a policy file could stop
 * enforcing anything and the only observable difference was that calls the
 * operator expected to be denied quietly succeeded.
 *
 * The loader now refuses such a file outright, which turns that silence into a
 * startup failure. This command is the other half: a way to find out BEFORE
 * deploying, with every problem in the file reported in one pass rather than
 * one exception at a time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { validatePolicyFile } from "../policy/gate.js";
import { VAULT_DIR } from "../shared/constants.js";
import type { CliOptions } from "./init.js";

/**
 * Strip control characters from untrusted text before it reaches a terminal.
 *
 * A policy file can name a key containing an ANSI escape, and zod quotes the key
 * back inside its issue message. Printing that raw lets the file repaint the
 * terminal of the operator running the diagnostic — including painting a passing
 * verdict over a failing one. AGENTS.md requires sanitising BEFORE clipping.
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

/** Default from `TrustConfigSchema.policies`. */
const DEFAULT_POLICIES_PATH = "./policies/default.yml";

/** Read just the `policies` key, tolerating a config that is otherwise unusable. */
function readPoliciesPath(vaultDir: string): string {
	try {
		const p = join(vaultDir, "usertrust.config.json");
		if (!existsSync(p)) return DEFAULT_POLICIES_PATH;
		const cfg = JSON.parse(readFileSync(p, "utf-8")) as { policies?: string };
		// The configured value VERBATIM, including "". `TrustConfigSchema` accepts
		// an empty string and both governors resolve it to the vault directory,
		// where the load fails — so substituting the default here would validate a
		// different file than the one that runs, and report ok for a deployment
		// that cannot start. A diagnostic must resolve its target the same way the
		// thing it diagnoses does.
		return typeof cfg.policies === "string" ? cfg.policies : DEFAULT_POLICIES_PATH;
	} catch {
		return DEFAULT_POLICIES_PATH;
	}
}

/**
 * Serialise with C1 escaped.
 *
 * `JSON.stringify` escapes C0 but leaves U+0080–U+009F literal, and U+009B is
 * the 8-bit CSI introducer — so `--json` piped straight to a terminal carries
 * the same repaint risk the human output is scrubbed for. Escaping rather than
 * substituting here, because JSON must stay round-trippable: a consumer gets the
 * real value back, a terminal never sees the raw byte.
 */
function toSafeJson(value: unknown): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the intent
	return JSON.stringify(value).replace(/[\u007f-\u009f]/g, (c) => {
		const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
		return `\\u${hex}`;
	});
}

export async function run(
	rootDir?: string,
	options: CliOptions = {},
	argv: string[] = [],
): Promise<void> {
	const sub = argv[0];
	if (sub !== undefined && sub !== "validate") {
		const reason = `Unknown policy subcommand: "${scrubForTerminal(sub, 40)}". Expected: validate`;
		// A caller passing --json parses every outcome, including this one.
		if (options.json) console.log(toSafeJson({ ok: false, error: "unknown_subcommand", reason }));
		else console.error(reason);
		process.exitCode = 2;
		return;
	}

	const vaultPath = rootDir ?? process.cwd();
	// Deliberately NOT `loadConfig`: that validates the whole config and throws on
	// a missing budget, which would make an operator fix their config before they
	// could find out why their policy stopped enforcing. Linting the policy file
	// must not depend on anything else being right.
	const policiesRel = readPoliciesPath(join(vaultPath, VAULT_DIR));
	// An explicit path wins, so an operator can check a file before installing it.
	const explicit = argv.find((a, i) => i > 0 && !a.startsWith("-"));
	const policiesPath = explicit ?? join(vaultPath, VAULT_DIR, policiesRel);

	const safePath = scrubForTerminal(policiesPath);
	// Validate FIRST. An `existsSync` preflight answers false for a file inside a
	// directory it cannot traverse, so this command would report `[none]` and exit
	// 0 for the very file the governor refuses to start against — a CI check that
	// passes while the deploy fails. Absence is whatever ENOENT says it is.
	const result = validatePolicyFile(policiesPath);
	if (!result.present) {
		// An ABSENT file at the CONFIGURED path is a legitimate deployment — no
		// policy file means the built-in budget rules apply, and that is a real
		// answer. A path the operator NAMED is different: they asked about a
		// specific file, and answering "ok" for a file that is not there would let
		// a CI step validate nothing and pass. Same distinction the loader draws
		// between absent and unreadable.
		if (explicit !== undefined) {
			const reason = `No such policy file: ${safePath}`;
			if (options.json)
				console.log(
					toSafeJson({
						ok: false,
						path: policiesPath,
						rules: 0,
						issues: [{ at: "file", message: "does not exist" }],
					}),
				);
			else console.log(`${pc.red("[missing]")} ${reason}`);
			process.exitCode = 1;
			return;
		}
		const msg = `No policy file at ${safePath} — only the built-in budget rules apply.`;
		if (options.json)
			console.log(toSafeJson({ ok: true, path: policiesPath, rules: 0, issues: [], note: msg }));
		else console.log(`${pc.yellow("[none]")} ${msg}`);
		return;
	}

	const { rules, issues } = result;

	if (options.json) {
		console.log(
			toSafeJson({
				ok: issues.length === 0,
				path: policiesPath,
				rules: rules.length,
				issues,
			}),
		);
		process.exitCode = issues.length === 0 ? 0 : 1;
		return;
	}

	console.log(`Policy file: ${safePath}`);
	if (issues.length > 0) {
		console.log(
			`${pc.red("[invalid]")} ${issues.length} problem(s) — NONE of this file's rules will load:`,
		);
		for (const issue of issues) {
			console.log(`  ${pc.red("×")} ${scrubForTerminal(`${issue.at}: ${issue.message}`)}`);
		}
		console.log("");
		console.log("A governor started against this file refuses to start rather than");
		console.log("enforcing an empty policy. Fix the above and re-run.");
		process.exitCode = 1;
		return;
	}

	if (rules.length === 0) {
		console.log(
			`${pc.yellow("[empty]")} valid, but declares 0 rules — only the built-in budget rules apply.`,
		);
		return;
	}

	const active = rules.filter((r) => r.enabled !== false).length;
	if (active === 0) {
		// Loaded is not the same as live: `ruleMatches` skips a disabled rule, so a
		// green "would enforce" over a file of disabled rules is the same false
		// reassurance the health line was fixed for.
		console.log(
			`${pc.yellow("[inert]")} ${rules.length} rule(s) load, but all are \`enabled: false\` — none can fire:`,
		);
	} else if (active < rules.length) {
		console.log(`${pc.green("[ok]")} ${active} of ${rules.length} rule(s) active:`);
	} else {
		console.log(`${pc.green("[ok]")} ${rules.length} rule(s) load and would enforce:`);
	}
	for (const r of rules) {
		const label = scrubForTerminal(r.id !== undefined ? `${r.id} — ${r.name}` : r.name, 120);
		const enf = r.enforcement === "hard" ? pc.red("hard") : pc.yellow("soft");
		const enabled = r.enabled === false ? pc.dim(" (disabled)") : "";
		console.log(`  ${pc.green("✓")} ${label}  [${r.effect}/${enf}]${enabled}`);
		// A scopePatterns rule only ever matches a context that carries a matching
		// `scope`, and no governed call path populates one. Saying so here is the
		// difference between a rule an operator believes is live and one that is.
		if (r.scopePatterns !== undefined && r.scopePatterns.length > 0) {
			console.log(
				pc.yellow(
					`      note: scoped to ${scrubForTerminal(r.scopePatterns.join(", "), 120)} — only matches calls that supply a matching context scope`,
				),
			);
		}
	}
}
