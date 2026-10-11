import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run as cli } from "../../src/cli/audit.js";
import { GLOBAL_FLAGS } from "../../src/cli/flags.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

/**
 * `usertrust audit` argument handling, held to the CLI's conventions (AGENTS.md, "A CLI command
 * uses an argument or refuses it"): the global flags (`cli/flags.ts`, the ONE list) are accepted
 * wherever `main.ts` forwards them; an argument of the wrong shape (no subcommand, an unknown one,
 * an unknown flag, an extra positional) is a usage error, exit 2; an operational failure — a
 * refusal, an interrupted repair — is exit 1.
 */

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const logOf = (v: string) => join(v, VAULT_DIR, "audit", "events.jsonl");

async function tornVault(): Promise<string> {
	const v = mkdtempSync(join(tmpdir(), "trust-cli-audit-"));
	dirs.push(v);
	const w = createAuditWriter(v);
	for (let i = 0; i < 2; i++) await w.appendEvent({ kind: "t", actor: "sys", data: { i } });
	w.release();
	appendFileSync(logOf(v), '{"id":"half-writ');
	return v;
}

/** Run the subcommand with `--json`; returns the exit code and the parsed JSON line. */
async function runJson(v: string, args: string[]) {
	const out: string[] = [];
	vi.spyOn(console, "log").mockImplementation((m: unknown) => {
		out.push(String(m));
	});
	await cli(v, { json: true }, args);
	vi.restoreAllMocks();
	const code = process.exitCode ?? 0;
	process.exitCode = undefined;
	return { code, out: JSON.parse(out[0] as string) as { success: boolean; data: unknown } };
}

describe("usertrust audit: the global flags are accepted (the shared list, never a copy)", () => {
	for (const flag of GLOBAL_FLAGS.filter((f) => f !== "--json")) {
		for (const args of [
			["quarantine-tail", "--dry-run", flag],
			["quarantine-tail", flag, "--dry-run"],
			[flag, "quarantine-tail", "--dry-run"],
		]) {
			it(`\`audit ${args.join(" ")}\` behaves as without ${flag}`, async () => {
				const v = await tornVault();
				const before = readFileSync(logOf(v));
				const without = await runJson(v, ["quarantine-tail", "--dry-run"]);
				const withFlag = await runJson(v, args);
				expect(withFlag).toEqual(without);
				expect(withFlag.code).toBe(0);
				expect(withFlag.out).toMatchObject({ success: true, data: { dryRun: true } });
				expect(readFileSync(logOf(v)).equals(before), "a dry run").toBe(true);
			});
		}
	}

	it("through the real entry point: `usertrust audit quarantine-tail --dry-run --skip-verify --json` exits 0", async () => {
		const v = await tornVault();
		const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
		const out = execFileSync(
			join(repoRoot, "node_modules", ".bin", "tsx"),
			[
				join(repoRoot, "packages", "core", "src", "cli", "main.ts"),
				"audit",
				"quarantine-tail",
				"--dry-run",
				GLOBAL_FLAGS.find((f) => f !== "--json") as string,
				"--json",
			],
			{ cwd: v, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
		);
		expect(JSON.parse(out.trim())).toMatchObject({ success: true, data: { dryRun: true } });
	}, 90_000);
});

describe("usertrust audit: a malformed invocation exits 2, an operational failure exits 1", () => {
	for (const [name, args] of [
		["no subcommand", []],
		["an unknown subcommand", ["quarantine"]],
		["an unknown flag", ["quarantine-tail", "--force"]],
		["a single-dash token", ["quarantine-tail", "-n"]],
		["an extra positional", ["quarantine-tail", "extra"]],
	] as const) {
		it(`${name} → usage, exit 2, nothing changed`, async () => {
			const v = await tornVault();
			const before = readFileSync(logOf(v));
			const r = await runJson(v, [...args]);
			expect(r.code).toBe(2);
			expect(r.out).toMatchObject({
				success: false,
				data: { message: expect.stringMatching(/^usage:/) },
			});
			expect(readFileSync(logOf(v)).equals(before)).toBe(true);
		});
	}

	it("control: a REFUSAL (an operational failure) still exits 1", async () => {
		const v = await tornVault();
		appendFileSync(logOf(v), "\n"); // the torn line is now a complete line that does not parse
		const r = await runJson(v, ["quarantine-tail"]);
		expect(r.code).toBe(1);
		expect(r.out).toMatchObject({
			success: false,
			data: { message: expect.stringMatching(/^audit quarantine refused/) },
		});
	});
});
