import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

/**
 * TRIPWIRE (usertrust#191's residue): openshell's `VaultAudit` verifies the chain incrementally
 * and REFUSES a chain with other `*.jsonl` segments, because core never writes one today. The
 * receipt specs plan sealed-segment rotation; the day core gains it, this test fails — and the
 * rotation PR must land openshell's multi-segment verify with it, or every openshell admission
 * halts at the first seal. Update the allowlist below ONLY together with that fold.
 */
const ROTATION_MESSAGE =
	"core may be gaining audit-log segment rotation: openshell's VaultAudit refuses multi-segment chains (usertrust#191 residue) — land its multi-segment verify in the same PR, then update this tripwire";

/**
 * A CENSUS of every `*.jsonl` name core's source mentions (writers, readers' suffix checks and
 * docs alike), and where. A new name, or a known name in a new place, trips this.
 */
const KNOWN_JSONL: Record<string, string[]> = {
	"*.jsonl": ["audit/read.ts", "audit/verify.ts"],
	".jsonl": [
		"audit/anchor-verify.ts",
		"audit/quarantine.ts",
		"audit/read.ts",
		"audit/verify.ts",
		"cli/health.ts",
	],
	"a.jsonl": ["cli/anchor.ts"],
	"anchors.jsonl": [
		"audit/anchor-verify.ts",
		"audit/anchor.ts",
		"cli/anchor.ts",
		"export/markdown.ts",
	],
	"dead-letter.jsonl": ["ledger/engine.ts"],
	"dead-letters.jsonl": ["audit/chain.ts"],
	"events.jsonl": [
		"audit/anchor-verify.ts",
		"audit/chain.ts",
		"audit/denial-events.ts",
		"audit/quarantine.ts",
		"audit/read.ts",
		"audit/verify.ts",
		"cli/health.ts",
		"cli/inspect.ts",
		"snapshot/checkpoint.ts",
	],
	"events.jsonl.meta": ["audit/anchor.ts", "cli/anchor.ts", "snapshot/checkpoint.ts"],
	"history.jsonl": ["board/board.ts"],
};

/** Every rename in core's audit layer, by file: anything new is a possible rotation. */
const KNOWN_RENAMES: Record<string, number> = {
	"audit/anchor.ts": 2, // identity.json's atomic write; the anchor lock's atomic reclaim
	"audit/chain.ts": 1, // the .meta head anchor's atomic replace (writeAnchorAtomically) — NOT the log
};

function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((e) => {
		const p = join(dir, e);
		return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
	});
}

describe("TRIPWIRE: core writes ONE audit log file (no segment rotation)", () => {
	it("behaviour: 200 appends leave exactly `events.jsonl` (+ its .meta) — no rotated segment", async () => {
		const v = mkdtempSync(join(tmpdir(), "trust-tripwire-"));
		try {
			const w = createAuditWriter(v);
			for (let i = 0; i < 200; i++) {
				await w.appendEvent({ kind: "test.t", actor: "sys", data: { i, pad: "x".repeat(2000) } });
			}
			w.release();
			const jsonl = readdirSync(join(v, VAULT_DIR, "audit")).filter((f) => f.endsWith(".jsonl"));
			expect(jsonl, ROTATION_MESSAGE).toEqual(["events.jsonl"]);
		} finally {
			rmSync(v, { recursive: true, force: true });
		}
	});

	it("source: every `*.jsonl` name in core is a known one, where it is known; nothing renames the log", () => {
		const root = join(__dirname, "..", "..", "src");
		const found: Record<string, string[]> = {};
		const renames: Record<string, number> = {};
		for (const file of sources(root)) {
			const text = readFileSync(file, "utf-8");
			const rel = relative(root, file);
			for (const m of text.matchAll(/["'`]([^"'`\n]*\.jsonl(?:\.meta)?)["'`]/g)) {
				const name = (m[1] as string).split("/").pop() as string;
				found[name] = [...new Set([...(found[name] ?? []), rel])].sort();
			}
			const n = [...text.matchAll(/\brename(?:Sync)?\s*\(/g)].length;
			if (rel.startsWith("audit/") && n > 0) renames[rel] = n;
		}
		expect(found, ROTATION_MESSAGE).toEqual(KNOWN_JSONL);
		expect(renames, ROTATION_MESSAGE).toEqual(KNOWN_RENAMES);
		// chain.ts's one rename replaces the .meta anchor, never the log.
		const chain = readFileSync(join(root, "audit", "chain.ts"), "utf-8");
		expect(
			[...chain.matchAll(/\brename(?:Sync)?\s*\(([^)]*)\)/g)].map((m) => m[1]),
			ROTATION_MESSAGE,
		).toEqual(["tmp, metaPath"]);
	});
});
