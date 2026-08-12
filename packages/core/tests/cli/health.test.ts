import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/health.js";

describe("usertrust health", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-health-"));
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prints missing vault message when no vault exists", async () => {
		await run(tempDir);

		expect(logOutput.some((l) => l.includes("usertrust init"))).toBe(true);
	});

	it("prints entropy score header", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Entropy score:");
		expect(combined).toContain("/100");
	});

	it("shows all 6 signal labels", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("Policy violations");
		expect(combined).toContain("Budget utilization");
		expect(combined).toContain("Chain integrity");
		expect(combined).toContain("PII detections");
		// RENAMED to what they measure. "Circuit breaker trips" counted no breaker
		// transition — no producer emits one — and reported an anomaly abort as a
		// trip; "Pattern memory hits" reported injection detections even with
		// pattern memory disabled. Both lines now take their caption from
		// `signal.label`, so a future rewiring cannot leave the name behind.
		expect(combined).toContain("Anomaly aborts");
		expect(combined).toContain("Injection pattern matches");
	});

	it("shows healthy status for empty vault", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("healthy");
		expect(combined).toContain("verified");
	});

	it("reports chain integrity as verified for valid chain", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({
			kind: "llm.call",
			actor: "test",
			data: { model: "claude-sonnet", cost: 100 },
		});
		writer.release();

		await run(tempDir);

		const combined = logOutput.join("\n");
		expect(combined).toContain("verified");
		expect(combined).toContain("[ok]");
	});

	it("computes budget utilization percentage", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		// From the PERSISTED LEDGER, not from summing the log. Summing `llm_call`
		// costs both over- and under-counted: it included cost-center calls, which
		// debit an envelope and never move session `budgetSpent`, and omitted
		// governed-action costs written under the dynamic action kinds.
		// `spend-ledger.json` is the number the governor itself seeds from.
		writeFileSync(
			join(vaultPath, "spend-ledger.json"),
			JSON.stringify({ budgetSpent: 150, updatedAt: new Date(0).toISOString() }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		// 150/50000 = 0.3%
		expect(combined).toContain("0.3%");
	});

	it("ABSTAINS on budget when no spend ledger exists", async () => {
		// A vault with a budget but no persisted spend has no honest utilization
		// figure. Reporting 0.0% is the display's floor; the SIGNAL abstains rather
		// than scoring a fabricated denominator.
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		const writer = createAuditWriter(tempDir);
		await writer.appendEvent({ kind: "llm_call", actor: "test", data: { cost: 150 } });
		writer.release();

		await run(tempDir);

		// The log carries a cost, but no ledger exists — so it is NOT summed.
		expect(logOutput.join("\n")).toContain("0.0%");
	});

	it("shows [ok] tags for zero-hit signals", async () => {
		const vaultPath = join(tempDir, ".usertrust");
		mkdirSync(join(vaultPath, "audit"), { recursive: true });
		writeFileSync(
			join(vaultPath, "usertrust.config.json"),
			JSON.stringify({ budget: 50000 }),
			"utf-8",
		);

		await run(tempDir);

		const combined = logOutput.join("\n");
		// All signals should show [ok] for empty vault
		const okCount = (combined.match(/\[ok\]/g) ?? []).length;
		expect(okCount).toBeGreaterThanOrEqual(5);
	});
});

describe("usertrust health — policy line", () => {
	let tempDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-health-policy-"));
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	function vault(config: Record<string, unknown>): void {
		const v = join(tempDir, ".usertrust");
		mkdirSync(join(v, "policies"), { recursive: true });
		writeFileSync(join(v, "usertrust.config.json"), JSON.stringify(config), "utf-8");
	}
	const out = (): string => logOutput.join("\n");

	it("does not echo terminal control sequences from a config-supplied path", async () => {
		// `policies` is read from the vault's config, so it is untrusted text
		// reaching a terminal: a tampered vault could otherwise repaint or forge
		// the human-readable verdict. The file already defines a scrubber; the
		// missing-file and invalid-file branches now use it.
		vault({ budget: 1000, policies: "./\u001b[2J\u001b[1;1Hall clear.yml" });
		await run(tempDir, { json: false });
		// Assert on the INJECTED payload specifically, not on "any escape byte".
		// picocolors emits real ANSI colour on a TTY and under CI's FORCE_COLOR, so
		// a blanket escape-free assertion passes locally and fails on a runner —
		// it would be testing the environment, not the scrubber.
		expect(out()).not.toContain("\u001b[2J"); // clear screen
		expect(out()).not.toContain("\u001b[1;1H"); // cursor home
		expect(out()).toContain("Policy rules loaded");
		// The path is still reported, just inert — the operator must still be told
		// WHICH file, or the diagnostic is useless.
		expect(out()).toContain("all clear.yml");
	});

	it("reports rules as inert when every rule is disabled", async () => {
		vault({ budget: 1000, policies: "./policies/default.yml" });
		writeFileSync(
			join(tempDir, ".usertrust", "policies", "default.yml"),
			`rules:
  - name: off-rule
    effect: deny
    enforcement: hard
    enabled: false
    conditions:
      - field: model
        operator: contains
        value: opus
`,
			"utf-8",
		);
		await run(tempDir, { json: false });
		// A loaded-but-disabled rule cannot fire; reporting it as live would put a
		// green count next to no enforcement.
		expect(out()).toContain("[inert]");
	});

	it("--json escapes C1 but preserves the real path value", async () => {
		// The human scrubber substitutes and clips, which is right for a terminal
		// and wrong for a machine-readable field: a consumer needs the value back.
		// JSON therefore escapes at serialisation and clips nothing.
		const CSI = String.fromCharCode(0x9b);
		vault({ budget: 1000, policies: `./${CSI}[2Jx.yml` });
		await run(tempDir, { json: true });
		const raw = out();
		expect(raw).not.toContain(CSI);
		const parsed = JSON.parse(raw) as { data: { policy: { path: string } } };
		expect(parsed.data.policy.path).toContain(CSI);
	});

	it("reports a broken config as invalid instead of validating the default", async () => {
		// health shared this bug with `policy validate` by copy: a malformed config
		// left the path at the default, so it validated ./policies/default.yml and
		// printed [ok] for a deployment whose config the governor rejects outright.
		// Both now use the one resolver in cli/policy-path.ts.
		const v = join(tempDir, ".usertrust");
		mkdirSync(join(v, "policies"), { recursive: true });
		writeFileSync(join(v, "policies", "default.yml"), "rules: []\n", "utf-8");
		writeFileSync(join(v, "usertrust.config.json"), "{ broken", "utf-8");
		await run(tempDir, { json: false });
		// [CONFIG], not [INVALID]: the config is the subject of the failure, and
		// naming policies/default.yml would point the operator at a file that is
		// probably fine and that the governor never reaches.
		expect(out()).toContain("[CONFIG]");
		expect(out()).not.toContain("default.yml");
	});

	it("--json reports the config failure without claiming a policy file is present", async () => {
		const v = join(tempDir, ".usertrust");
		mkdirSync(join(v, "policies"), { recursive: true });
		writeFileSync(join(v, "policies", "default.yml"), "rules: []\n", "utf-8");
		writeFileSync(join(v, "usertrust.config.json"), "{ broken", "utf-8");
		await run(tempDir, { json: true });
		const p = JSON.parse(out()) as {
			data: { policy: { path: string | null; present: boolean; configError?: string } };
		};
		expect(p.data.policy.path).toBeNull();
		expect(p.data.policy.present).toBe(false);
		expect(p.data.policy.configError).toMatch(/not valid JSON/);
	});

	it("distinguishes no policy file from a loaded policy", async () => {
		vault({ budget: 1000, policies: "./policies/default.yml" });
		await run(tempDir, { json: false });
		expect(out()).toContain("[none]");
		expect(out()).toContain("built-in budget rules only");
	});
});
