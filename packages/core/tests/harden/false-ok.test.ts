// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The false-OK family: three places that answered "fine" to a question they
 * could not read.
 *
 * Each of these took the PERMISSIVE branch on uninterpretable input — an
 * unparseable date, an unlistable directory, a malformed PEM — and reported
 * success. None of them were detectable downstream, because the output of each
 * is indistinguishable from the genuine healthy case: an unexpired credential,
 * an empty vault, a complete snapshot.
 *
 * They are grouped in one file deliberately. They live in three subsystems and
 * share no code, but they are one defect, and the next instance of it will be
 * found by someone reading this file rather than by someone reading any one of
 * the three modules.
 *
 * The fourth member of this family — an unparseable `--successor-pin` — moved to
 * its own branch: it edits a verdict lattice with precedence rules and needed
 * three review rounds, and bundling it here let one hard change gate three
 * one-liners.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyVault } from "../../src/audit/verify.js";
import type { CredentialScope } from "../../src/shared/types.js";
import { createSnapshot } from "../../src/snapshot/checkpoint.js";
import { checkScope } from "../../src/vault/scope.js";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "usertrust-false-ok-"));
});

afterEach(() => {
	// Restore traversability first — a 0o000 dir cannot be removed recursively.
	try {
		rmSync(tmp, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup; the OS reclaims the temp dir regardless.
	}
});

describe("false OK — an unparseable credential expiry", () => {
	const scope = (expiresAt: string | null): CredentialScope =>
		({ agents: [], actions: [], expiresAt }) as unknown as CredentialScope;
	const accessor = { agent: "a", action: "read" } as Parameters<typeof checkScope>[1];

	it("DENIES an expiry that cannot be parsed", () => {
		// `new Date("not-a-date").getTime()` is NaN, and `NaN <= Date.now()` is
		// false — so this fell through to allowed:true and an unreadable expiry
		// read as "not expired".
		const result = checkScope(scope("not-a-date"), accessor);
		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/not a valid date/i);
	});

	it("still denies a genuinely expired credential", () => {
		expect(checkScope(scope("2020-01-01T00:00:00.000Z"), accessor).allowed).toBe(false);
	});

	it("still allows a future expiry and a null expiry", () => {
		expect(checkScope(scope("2999-01-01T00:00:00.000Z"), accessor).allowed).toBe(true);
		expect(checkScope(scope(null), accessor).allowed).toBe(true);
	});
});

describe("false OK — an audit directory that cannot be enumerated", () => {
	it("does NOT report a clean vault it could not read", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		// A segment exists, so this vault is NOT empty. With `events.jsonl` absent
		// and the directory unreadable, the old code returned
		// `valid: true, chainLength: 0` — a clean bill of health, exit 0, on a
		// vault nobody could open.
		await writeFile(join(auditDir, "segment-1.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			const result = verifyVault(vault);
			// Running as root defeats permission bits entirely; skip rather than
			// assert a false negative on a machine where the setup cannot hold.
			if (result.chainLength > 0) return;
			expect(result.valid).toBe(false);
			expect(result.errors.join(" ")).toMatch(/could not be enumerated/i);
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still reports a genuinely absent audit directory honestly", () => {
		const result = verifyVault(join(tmp, "nope"));
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/not found/i);
	});

	it("still verifies a readable empty vault as empty, not as broken", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		const result = verifyVault(vault);
		expect(result.valid).toBe(true);
		expect(result.chainLength).toBe(0);
	});
});

describe("false OK — a snapshot built from an unreadable vault", () => {
	it("FAILS rather than writing a silently incomplete snapshot", async () => {
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		try {
			// PROBE, don't pattern-match the failure. Root ignores mode 000, and the
			// previous guard tried to detect that by matching /rejects/ against
			// Vitest's message — which says "instead of rejecting", so the guard
			// rethrew instead of skipping. Ask the filesystem directly.
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				await expect(createSnapshot(vault, "snap")).rejects.toThrow(/enumerate/i);
			}
		} finally {
			await chmod(auditDir, 0o700);
		}
	});

	it("still snapshots a readable vault", async () => {
		const vault = join(tmp, ".usertrust");
		await mkdir(join(vault, "audit"), { recursive: true });
		writeFileSync(join(vault, "audit", "events.jsonl"), "{}\n", "utf-8");
		await expect(createSnapshot(vault, "snap")).resolves.toBeDefined();
	});
});

describe("false OK — the fail-closed error must still be machine-readable", () => {
	it("snapshot create --json emits success:false rather than an uncaught throw", async () => {
		// A fail-closed error a machine consumer cannot read is only half-surfaced.
		// The new enumeration failure arrives as a throw, and unguarded it printed
		// no JSON at all — breaking the every-command JSON contract on exactly the
		// path this change exists to expose.
		const vault = join(tmp, ".usertrust");
		const auditDir = join(vault, "audit");
		await mkdir(auditDir, { recursive: true });
		await writeFile(join(auditDir, "events.jsonl"), "{}\n", "utf-8");
		await chmod(auditDir, 0o000);

		const logged: string[] = [];
		const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
			logged.push(String(m));
		});
		const argv = process.argv;
		const exitCode = process.exitCode;
		process.argv = ["node", "usertrust", "snapshot", "create", "snap", "--json"];
		try {
			let readable = true;
			try {
				await readdir(auditDir);
			} catch {
				readable = false;
			}
			if (!readable) {
				const { run } = await import("../../src/cli/snapshot.js");
				await run(tmp, { json: true } as never);
				const out = logged.join("\n");
				expect(() => JSON.parse(out) as unknown).not.toThrow();
				expect(JSON.parse(out)).toMatchObject({ command: "snapshot", success: false });
			}
		} finally {
			process.argv = argv;
			process.exitCode = exitCode;
			spy.mockRestore();
			await chmod(auditDir, 0o700);
		}
	});
});

describe("false OK — a documented count that stops matching reality", () => {
	/**
	 * AGENTS.md asserts an EXACT number of sanitizers and enumerates them. That
	 * number went stale twice while this guard was being written: once when a
	 * mirrored pair was added, and again when the count was corrected for a
	 * different copy while that pair stayed uncounted.
	 *
	 * A prose invariant nobody executes is the same shape as a health signal
	 * nobody wired: it reads as authoritative and measures nothing.
	 *
	 * ── WHY THIS MATCHES ON SHAPE, NOT ON NAMES ──
	 *
	 * The first version of this guard counted three known function NAMES. It
	 * worked — it caught a stale count within a minute of the next AGENTS.md edit
	 * — and it was wrong in the direction it exists to catch: a fourth sanitizer
	 * landed under a fourth name (`scrubForTerminal`) and the counter reported
	 * ELEVEN where THIRTEEN existed, failing a correct update. A counter that only
	 * knows the names it was written with reports a smaller inventory than exists,
	 * which is the same false OK this file is named for, one level up.
	 *
	 * So it counts what a sanitizer DOES. Both variants have an unmistakable
	 * signature: the stronger one covers the C1 range and therefore names `0x9f`;
	 * the weaker one is the `CONTROL_CHARS` character-class regex. Any future copy
	 * under any name is counted, because the thing being counted is the behaviour
	 * rather than the label — the same move as deriving fixtures from real
	 * producer call sites instead of inventing them.
	 */
	it("AGENTS.md's sanitizer count matches the sanitizers in src/", async () => {
		const { readFile } = await import("node:fs/promises");
		const { execSync } = await import("node:child_process");
		const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");

		const agents = await readFile(join(repoRoot, "AGENTS.md"), "utf-8");
		const declared = agents.match(/There are \*\*(\w+)\*\* sanitizers/)?.[1];
		expect(declared, "AGENTS.md no longer states a sanitizer count").toBeDefined();

		const WORDS: Record<string, number> = {
			six: 6,
			seven: 7,
			eight: 8,
			nine: 9,
			ten: 10,
			eleven: 11,
			twelve: 12,
			thirteen: 13,
			fourteen: 14,
			fifteen: 15,
			sixteen: 16,
		};
		const declaredCount = WORDS[declared as string];
		expect(declaredCount, `unrecognised number word "${declared}"`).toBeDefined();

		// Count OCCURRENCES of each variant's signature, not files and not names.
		// EXTENDED-REGEX, so the patterns can admit any identifier spelling.
		const occurrences = (pattern: string): number => {
			const out = execSync(
				`grep -rhoE '${pattern}' ${join(repoRoot, "packages")}/*/src --include='*.ts' || true`,
				{ encoding: "utf-8" },
			).trim();
			return out === "" ? 0 : out.split("\n").length;
		};
		// Stronger variant: the C1 comparison, with the local's NAME left open.
		//
		// Four rounds of correction landed here, each generalizing the part that had
		// just failed and leaving the part that had not yet been tested:
		//   1. matched three function NAMES        — missed a fourth name;
		//   2. matched bare `0x9f`                 — counted two doc comments as code;
		//   3. matched the constant `CONTROL_CHARS`— missed any other binding;
		//   4. matched the literal `code >= ...`   — missed a local named `codePoint`.
		//
		// A matcher gets audited where it was last wrong. What survives all four is
		// the SHAPE: the two range bounds and the operators between them, with every
		// identifier a wildcard. The bounds are the behaviour; the names are not.
		const strong = occurrences(">= *0x7f *&& *[A-Za-z_$][A-Za-z0-9_$]* *<= *0x9f");
		// Weaker variant: the character class ITSELF, bound to any name. Matching
		// `CONTROL_CHARS` left half the guard name-based — a weak sanitizer under
		// another constant name would have gone uncounted and a stale total would
		// still have passed. The `= ` anchor keeps it to DEFINITIONS: the bare
		// class also appears in two doc comments describing it, the same
		// prose-counts-as-code trap the strong matcher fell into first.
		const weak = occurrences("= */\\[\\\\x00-\\\\x1f\\\\x7f\\]/g");

		expect(
			strong + weak,
			`AGENTS.md says ${declaredCount}; src/ contains ${strong} C1-covering + ${weak} control-class = ${strong + weak}. ` +
				"Add a bullet to the inventory and update the total — the entries are deliberately unnumbered so nothing needs renumbering.",
		).toBe(declaredCount);
	});
});
