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
		const { readFile, readdir } = await import("node:fs/promises");
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

		/**
		 * Strip comments and string literals, then collapse whitespace.
		 *
		 * This replaces a `grep -o` sweep, which was wrong at BOTH ends: it could
		 * not see a signature that Biome had wrapped across lines (undercounting a
		 * real copy), and it counted the same signature appearing inside a doc
		 * comment or a string (overcounting prose as implementation). Line-oriented
		 * text matching cannot distinguish code from writing about code.
		 *
		 * HONEST LIMIT: this is a lexical approximation, not a parse. It does not
		 * model template literals with embedded expressions, regex literals
		 * containing quote characters, or nested comment edge cases. It is enough
		 * for the question asked — does a control-range comparison exist in code —
		 * and if that ever stops being true, this comment is the place to escalate
		 * to the TypeScript AST rather than adding another special case.
		 */
		const codeOnly = (src: string): string =>
			src
				.replace(/\/\*[\s\S]*?\*\//g, " ")
				.replace(/\/\/[^\n]*/g, " ")
				.replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
				.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
				.replace(/`(?:[^`\\]|\\.)*`/g, "``")
				.replace(/\s+/g, " ");

		const tsFiles = async (dir: string): Promise<string[]> => {
			const out: string[] = [];
			for (const e of await readdir(dir, { withFileTypes: true })) {
				const full = join(dir, e.name);
				if (e.isDirectory()) out.push(...(await tsFiles(full)));
				else if (e.name.endsWith(".ts")) out.push(full);
			}
			return out;
		};

		const pkgs = join(repoRoot, "packages");
		const srcDirs = (await readdir(pkgs, { withFileTypes: true }))
			.filter((e) => e.isDirectory())
			.map((e) => join(pkgs, e.name, "src"));

		let strong = 0;
		let weak = 0;
		// Identifiers are wildcards: the range bounds and operators are the
		// behaviour, the names around them are incidental.
		// BOTH BOUNDS BIND ONE IDENTIFIER, via a back-reference. Without it this
		// also matched `start >= 0x7f && end <= 0x9f` — an INTERVAL check over two
		// variables, not a sanitizer testing a single code point. Unrelated code
		// could then inflate the count, or offset a genuinely removed sanitizer so
		// the total still agreed. A shape matcher has to match the shape, and two
		// different variables is a different shape.
		const STRONG = /([A-Za-z_$][A-Za-z0-9_$]*) *>= *0x7f *&& *\1 *<= *0x9f/g;
		const WEAK = /= *\/\[\\x00-\\x1f\\x7f\]\/g/g;
		for (const dir of srcDirs) {
			let files: string[];
			try {
				files = await tsFiles(dir);
			} catch (err) {
				// ONLY a genuinely absent directory is "no source". A blanket catch
				// here read EACCES or an I/O error as an empty package, so a new
				// sanitizer in an unreadable tree went uncounted and the stale total
				// passed — the guard failing exactly the way the file it lives in is
				// named for, in the guard written to catch that.
				if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
				throw err;
			}
			for (const f of files) {
				const code = codeOnly(await readFile(f, "utf-8"));
				strong += code.match(STRONG)?.length ?? 0;
				weak += code.match(WEAK)?.length ?? 0;
			}
		}

		expect(
			strong + weak,
			`AGENTS.md says ${declaredCount}; src/ contains ${strong} C1-covering + ${weak} control-class = ${strong + weak}. ` +
				"Add a bullet to the inventory and update the total — the entries are deliberately unnumbered so nothing needs renumbering.",
		).toBe(declaredCount);
	});
});
