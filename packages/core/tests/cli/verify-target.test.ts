// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust verify <path>` must verify THAT path, and every command that takes no path must
 * refuse one rather than silently answer about the cwd.
 *
 * These drive the real CLI entry point (`cli/main.ts`) in a child process with a controlled cwd.
 * The defect lived in main.ts dropping the argument and in the cwd fallback, so an in-process call
 * to `run()` would pass over the wiring that failed. Every cwd below is itself a VALID vault (or a
 * valid empty dir) on purpose: a silent fallback to the cwd must produce a different, visible
 * answer than the path that was asked for.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";

const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
const TSX = join(repoRoot, "node_modules", ".bin", "tsx");
const MAIN = join(repoRoot, "packages", "core", "src", "cli", "main.ts");

interface Out {
	stdout: string;
	stderr: string;
	code: number | null;
}

function cli(cwd: string, ...args: string[]): Out {
	const r = spawnSync(TSX, [MAIN, ...args], { cwd, encoding: "utf-8", timeout: 60_000 });
	return { stdout: r.stdout, stderr: r.stderr, code: r.status };
}

async function makeVault(dir: string, events: number): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const w = createAuditWriter(dir);
	for (let i = 0; i < events; i++) {
		await w.appendEvent({ kind: "llm_call", actor: "local", data: { i } });
	}
	await w.flush();
	w.release();
}

let tmp: string;
let vaultA: string; // 3 events
let vaultB: string; // 1 event
let empty: string;

beforeAll(async () => {
	tmp = realpathSync(mkdtempSync(join(tmpdir(), "trust-verify-target-")));
	vaultA = join(tmp, "vault-a");
	vaultB = join(tmp, "vault-b");
	empty = join(tmp, "empty");
	mkdirSync(empty);
	await makeVault(vaultA, 3);
	await makeVault(vaultB, 1);
}, 60_000);

afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const json = (o: Out): { success: boolean; data: Record<string, unknown> } =>
	JSON.parse(o.stdout.split("\n").find((l) => l.startsWith("{")) as string);

describe("verify <path> verifies that path", () => {
	it("T1: from inside vault-b, `verify vault-a` reports vault-a's chain, not vault-b's", () => {
		const out = cli(vaultB, "verify", vaultA);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("3 events");
		expect(out.stdout).not.toContain("1 events");
		expect(out.stdout).toContain(join(vaultA, ".usertrust"));

		const j = json(cli(vaultB, "verify", vaultA, "--json"));
		const own = json(cli(vaultB, "verify", "--json"));
		expect(j.data.chainLength).toBe(3);
		expect(own.data.chainLength).toBe(1);
		expect(j.data.merkleRoot).not.toBe(own.data.merkleRoot);
		expect(j.data.vaultPath).toBe(join(vaultA, ".usertrust"));
	}, 60_000);

	it("T1b: a symlinked vault shows the directory actually verified", () => {
		const link = join(tmp, "link-to-a");
		symlinkSync(vaultA, link);
		const out = cli(vaultB, "verify", link);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("3 events");
		expect(out.stdout).toContain(join(vaultA, ".usertrust"));
		expect(out.stdout).not.toContain("link-to-a");
	}, 60_000);

	it("T2: from an empty directory, `verify vault-a` verifies vault-a", () => {
		const out = cli(empty, "verify", vaultA);
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("3 events");
		expect(out.stdout).not.toContain("No trust vault found");
	}, 60_000);

	it("T3: with no path it verifies the cwd, and says which", () => {
		const out = cli(vaultA, "verify");
		expect(out.code).toBe(0);
		expect(out.stdout).toContain("3 events");
		expect(out.stdout).toContain(join(vaultA, ".usertrust"));
		expect(json(cli(vaultA, "verify", "--json")).data.vaultPath).toBe(join(vaultA, ".usertrust"));
	}, 60_000);

	it("T3b: anchor mode names the vault too, in both output modes", () => {
		// --require-anchor puts verify on the anchored path (its own output code), where an
		// unanchored vault is a non-zero verdict; the subject must still be named.
		const human = cli(vaultB, "verify", vaultA, "--require-anchor");
		expect(human.stdout).toContain(join(vaultA, ".usertrust"));
		expect(human.stdout).toContain("3 events");
		const j = json(cli(vaultB, "verify", vaultA, "--require-anchor", "--json"));
		expect(j.data.vaultPath).toBe(join(vaultA, ".usertrust"));
		expect(j.data.chainLength).toBe(3);
	}, 60_000);

	it("T4: a path it cannot use is refused; the cwd (a valid vault) is never used instead", () => {
		const notDir = join(tmp, "a-file");
		writeFileSync(notDir, "x");
		const cases: Array<[string[], number, RegExp]> = [
			[[join(tmp, "does-not-exist")], 1, /not a directory/],
			[[notDir], 1, /not a directory/],
			[[empty], 1, /No trust vault found at/],
			[[join(vaultA, ".usertrust")], 1, /project root/],
			[[vaultA, vaultB], 2, /one path/i],
		];
		for (const [args, code, re] of cases) {
			const out = cli(vaultB, "verify", ...args);
			expect(out.code, args.join(" ")).toBe(code);
			expect(out.stdout, args.join(" ")).toMatch(re);
			expect(out.stdout, args.join(" ")).not.toContain("Chain verified");
		}
	}, 120_000);

	it("T5: a flag's value is never mistaken for the path, in either order", () => {
		const anchors = join(tmp, "anchors.jsonl");
		writeFileSync(anchors, "");
		for (const args of [
			["verify", vaultA, "--max-unanchored-events", "5"],
			["verify", "--max-unanchored-events", "5", vaultA],
			["verify", "--vault-id", "vid", vaultA],
		]) {
			const out = cli(vaultB, ...args, "--json");
			const j = json(out);
			expect(j.data.vaultPath, args.join(" ")).toBe(join(vaultA, ".usertrust"));
			expect(j.data.chainLength, args.join(" ")).toBe(3);
		}
	}, 120_000);

	it("T6: a hostile path is not echoed raw to the terminal", () => {
		const ESC = String.fromCodePoint(0x1b);
		const C1 = String.fromCodePoint(0x9b);
		for (const hostile of [`${ESC}[2Jx`, `${C1}2Jx`]) {
			const out = cli(vaultB, "verify", join(tmp, hostile));
			expect(out.stdout).not.toContain(ESC);
			expect(out.stdout).not.toContain(C1);
			expect(out.code).toBe(1);
		}
	}, 60_000);

	it("T6b: a vault whose own path holds control characters is named safely", async () => {
		const ESC = String.fromCodePoint(0x1b);
		const C1 = String.fromCodePoint(0x9b);
		const odd = join(tmp, `odd-${ESC}[2J-${C1}`);
		await makeVault(odd, 2);
		const human = cli(empty, "verify", odd);
		expect(human.code).toBe(0);
		expect(human.stdout).toContain("2 events");
		expect(human.stdout).not.toContain(ESC);
		expect(human.stdout).not.toContain(C1);
		// --json keeps the real path recoverable, with C1 escaped at serialization.
		const raw = cli(empty, "verify", odd, "--json").stdout;
		expect(raw).not.toContain(C1);
		expect(json({ stdout: raw, stderr: "", code: 0 }).data.vaultPath).toBe(join(odd, ".usertrust"));
	}, 60_000);

	it("T6c: an error that embeds the selected path is scrubbed too (vault dir without audit/)", () => {
		const ESC = String.fromCodePoint(0x1b);
		const C1 = String.fromCodePoint(0x9b);
		const broken = join(tmp, `broken-${ESC}[2J-${C1}`);
		mkdirSync(join(broken, ".usertrust"), { recursive: true });
		// Plain mode and anchor mode print their errors at different sites.
		for (const extra of [[], ["--require-anchor"]]) {
			const out = cli(empty, "verify", broken, ...extra);
			expect(out.code, extra.join(" ")).toBe(1);
			expect(out.stdout, extra.join(" ")).toContain("Audit directory not found");
			expect(out.stdout, extra.join(" ")).not.toContain(ESC);
			expect(out.stdout, extra.join(" ")).not.toContain(C1);
		}
	}, 60_000);
});

describe("commands that take no path refuse one", () => {
	const NO_PATH = ["inspect", "health", "pricing", "init", "export"] as const;

	it("T7c: global flags in any position don't change what is a positional (export --markdown --json out)", () => {
		const out = join(tmp, "out-json-order");
		const r = cli(vaultA, "export", "--markdown", "--json", out);
		expect(r.code, r.stdout).not.toBe(2);
		expect(r.stdout).not.toContain("takes no path");
		expect(realpathSync(out)).toBeTruthy();
	}, 60_000);

	it("T7: a stray positional is refused (exit 2), never answered from the cwd", () => {
		for (const cmd of NO_PATH) {
			const extra = cmd === "export" ? ["--markdown", join(tmp, "out")] : [];
			const out = cli(vaultB, cmd, vaultA, ...extra);
			expect(out.code, cmd).toBe(2);
			expect(out.stdout, cmd).toContain("takes no path");
		}
		// The refusal carries the flag set too, and is structured under --json.
		const j = json(cli(vaultB, "inspect", vaultA, "--json"));
		expect(j.success).toBe(false);
		expect(j.data.message).toContain("takes no path");
	}, 120_000);

	it("T7b: nothing ran: `init <path>` did not initialise the cwd, `export <path>` wrote nothing", () => {
		const fresh = join(tmp, "fresh");
		mkdirSync(fresh);
		cli(fresh, "init", vaultA, "--json");
		cli(vaultB, "export", vaultA, "--markdown", join(tmp, "never"));
		expect(() => realpathSync(join(fresh, ".usertrust"))).toThrow();
		expect(() => realpathSync(join(tmp, "never"))).toThrow();
	}, 60_000);

	it("T8: a bare invocation still works (no behaviour change for correct use)", () => {
		const fresh = join(tmp, "fresh2");
		mkdirSync(fresh);
		for (const [cmd, args, cwd] of [
			["inspect", [], vaultA],
			["health", [], vaultA],
			["pricing", [], vaultA],
			["init", ["--json"], fresh],
			["export", ["--markdown", join(tmp, "out-ok")], vaultA],
		] as const) {
			const out = cli(cwd, cmd, ...args);
			expect(out.code, `${cmd}: ${out.stdout}${out.stderr}`).not.toBe(2);
			expect(out.stdout, cmd).not.toContain("takes no path");
		}
		expect(realpathSync(join(fresh, ".usertrust"))).toBeTruthy();
	}, 120_000);
});
