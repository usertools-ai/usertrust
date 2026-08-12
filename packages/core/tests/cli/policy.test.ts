// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust policy validate` — the operator-facing half of the loader fix.
 *
 * The loader now refuses a policy file it cannot honour, which turns a silent
 * non-enforcement into a startup failure. This command is how an operator finds
 * out BEFORE deploying, and its absence was the reason the original defect was
 * uncatchable locally: there was no way to ask "will these rules actually load?"
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/policy.js";

const GOOD_YAML = `rules:
  - id: no-frontier
    name: Block frontier models
    effect: deny
    enforcement: hard
    conditions:
      - field: model
        operator: contains
        value: opus
`;

describe("usertrust policy validate", () => {
	let tempDir: string;
	let logged: string[];

	function writePolicy(content: string): void {
		const dir = join(tempDir, ".usertrust", "policies");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "default.yml"), content, "utf-8");
	}

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-policy-cli-"));
		logged = [];
		vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
			logged.push(a.join(" "));
		});
		vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
			logged.push(a.join(" "));
		});
		process.exitCode = undefined;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	const out = (): string => logged.join("\n");

	it("reports a valid policy and lists what would enforce", async () => {
		writePolicy(GOOD_YAML);
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("1 rule(s) load");
		expect(out()).toContain("no-frontier");
		expect(process.exitCode).toBeUndefined();
	});

	it("EXITS NON-ZERO and names the problem for an unparseable file", async () => {
		writePolicy(GOOD_YAML.replace("  - id: no-frontier", "\t- id: no-frontier"));
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("NONE of this file's rules will load");
		expect(process.exitCode).toBe(1);
	});

	it("locates a misspelled operator down to the condition", async () => {
		writePolicy(GOOD_YAML.replace("operator: contains", "operator: contain"));
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("rules[0].conditions[0].operator");
		expect(process.exitCode).toBe(1);
	});

	it("distinguishes 'no policy file' from 'policy loaded'", async () => {
		// The distinction the health line existed to make: an operator must never
		// read "fine" and conclude their rules are live.
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("only the built-in budget rules apply");
		expect(process.exitCode).toBeUndefined();
	});

	it("flags a scopePatterns rule as conditional on a caller-supplied scope", async () => {
		writePolicy(`rules:
  - id: prod-only
    name: Prod only
    effect: deny
    enforcement: hard
    scopePatterns: ["production/*"]
    conditions:
      - field: model
        operator: contains
        value: opus
`);
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("only matches calls that supply a matching context scope");
	});

	it("--json reports ok/rules/issues machine-readably", async () => {
		writePolicy(GOOD_YAML.replace("operator: contains", "operator: contain"));
		await run(tempDir, { json: true }, ["validate"]);
		const payload = JSON.parse(out()) as {
			ok: boolean;
			rules: number;
			issues: { at: string; message: string }[];
		};
		expect(payload.ok).toBe(false);
		expect(payload.rules).toBe(0);
		expect(payload.issues.length).toBeGreaterThan(0);
		expect(process.exitCode).toBe(1);
	});

	it("reports an all-disabled file as inert, not as enforcing", async () => {
		writePolicy(
			GOOD_YAML.replace("    enforcement: hard", "    enforcement: hard\n    enabled: false"),
		);
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).toContain("[inert]");
		expect(out()).toContain("none can fire");
	});

	it("does not echo control sequences from a config-supplied path", async () => {
		mkdirSync(join(tempDir, ".usertrust"), { recursive: true });
		writeFileSync(
			join(tempDir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 1000, policies: "./\u001b[2J\u001b[1;1Hall clear.yml" }),
			"utf-8",
		);
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).not.toContain("\u001b[2J");
		expect(out()).not.toContain("\u001b[1;1H");
		expect(out()).toContain("all clear.yml");
	});

	it("escapes C1 controls in --json output", async () => {
		// JSON.stringify escapes C0 and leaves C1 literal, and U+009B is the 8-bit
		// CSI introducer — so --json piped to a terminal carried the repaint risk
		// the human output is scrubbed for.
		const CSI = String.fromCharCode(0x9b);
		mkdirSync(join(tempDir, ".usertrust"), { recursive: true });
		writeFileSync(
			join(tempDir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 1000, policies: `./${CSI}[2Jx.yml` }),
			"utf-8",
		);
		await run(tempDir, { json: true }, ["validate"]);
		expect(out()).not.toContain(CSI);
		expect(out()).toContain("\\u009b");
		// Still valid JSON, and still round-trips to the real value.
		const parsed = JSON.parse(out()) as { path: string };
		expect(parsed.path).toContain(CSI);
	});

	it("validates the CONFIGURED path verbatim, including an empty one", async () => {
		// TrustConfigSchema accepts `policies: ""` and both governors resolve it to
		// the vault directory, where the load fails. Substituting the default here
		// would report ok for a deployment that cannot start.
		mkdirSync(join(tempDir, ".usertrust", "policies"), { recursive: true });
		writeFileSync(join(tempDir, ".usertrust", "policies", "default.yml"), GOOD_YAML, "utf-8");
		writeFileSync(
			join(tempDir, ".usertrust", "usertrust.config.json"),
			JSON.stringify({ budget: 1000, policies: "" }),
			"utf-8",
		);
		await run(tempDir, { json: false }, ["validate"]);
		expect(out()).not.toContain("[ok]");
		expect(process.exitCode).toBe(1);
	});

	it("rejects an unknown subcommand rather than silently validating", async () => {
		writePolicy(GOOD_YAML);
		await run(tempDir, { json: false }, ["lint"]);
		expect(out()).toContain("Unknown policy subcommand");
		expect(process.exitCode).toBe(2);
	});
});
