import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AuditTornTailError,
	AuditWriterLockHeldError,
	createAuditWriter,
} from "../../src/audit/chain.js";
import {
	AuditQuarantineRefusedError,
	QUARANTINE_EVENT_KIND,
	quarantineTornTail,
} from "../../src/audit/quarantine.js";
import { verifyVault } from "../../src/audit/verify.js";
import { run as cli } from "../../src/cli/audit.js";
import { VAULT_DIR } from "../../src/shared/constants.js";

const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const auditDirOf = (v: string) => join(v, VAULT_DIR, "audit");
const logOf = (v: string) => join(auditDirOf(v), "events.jsonl");
const lines = (v: string) => readFileSync(logOf(v), "utf-8").trim().split("\n");

/** A vault with `n` events and then, unless `torn` is null, a torn tail. */
async function vault(n: number, torn: string | null = '{"id":"half-writ'): Promise<string> {
	const v = mkdtempSync(join(tmpdir(), "trust-torn-"));
	dirs.push(v);
	const w = createAuditWriter(v);
	for (let i = 0; i < n; i++) await w.appendEvent({ kind: "test.e", actor: "sys", data: { i } });
	w.release();
	if (torn !== null) appendFileSync(logOf(v), torn);
	return v;
}

describe("#194: the writer never appends onto a torn tail", () => {
	it("a log whose last bytes follow its last newline: the append refuses, the bytes untouched", async () => {
		const v = await vault(2);
		const before = readFileSync(logOf(v));
		const w = createAuditWriter(v);
		await expect(w.appendEvent({ kind: "x", actor: "sys", data: {} })).rejects.toBeInstanceOf(
			AuditTornTailError,
		);
		w.release();
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
	});
});

describe("#194.2: quarantine-tail — the ONE repair, recorded on the chain", () => {
	it("dry run: reports the torn tail and changes nothing", async () => {
		const v = await vault(2);
		const before = readFileSync(logOf(v));
		const r = await quarantineTornTail(v, { dryRun: true });
		expect(r.torn).toMatchObject({ length: 16 });
		expect(r.recorded).toEqual([r.torn?.sha256]);
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
		expect(existsSync(join(auditDirOf(v), "quarantine"))).toBe(false);
	});

	it("moves the torn bytes aside byte for byte, cuts the log back, records it on the chain — the vault verifies and appends resume", async () => {
		const v = await vault(2);
		const offset = readFileSync(logOf(v)).lastIndexOf(0x0a) + 1;
		const r = await quarantineTornTail(v);
		expect(r.torn).toMatchObject({ offset, length: 16 });
		expect(readFileSync(join(auditDirOf(v), r.torn?.file as string), "utf-8")).toBe(
			'{"id":"half-writ',
		);
		const rec = JSON.parse(lines(v).at(-1) as string) as {
			kind: string;
			data: Record<string, unknown>;
		};
		expect(rec).toMatchObject({
			kind: QUARANTINE_EVENT_KIND,
			data: { sha256: r.torn?.sha256, length: 16, offset, file: r.torn?.file },
		});
		expect(verifyVault(join(v, VAULT_DIR))).toMatchObject({ valid: true, chainLength: 3 });
		const w = createAuditWriter(v);
		await w.appendEvent({ kind: "test.after", actor: "sys", data: {} });
		w.release();
		expect(verifyVault(join(v, VAULT_DIR)).valid).toBe(true);
	});

	it("a run that died AFTER truncating but BEFORE its record is finished by the next run, once", async () => {
		const v = await vault(2, null);
		mkdirSync(join(auditDirOf(v), "quarantine"));
		writeFileSync(join(auditDirOf(v), "quarantine", `${"a".repeat(64)}.torn`), "torn-bytes");
		expect((await quarantineTornTail(v)).recorded).toEqual(["a".repeat(64)]);
		expect(JSON.parse(lines(v).at(-1) as string)).toMatchObject({
			kind: QUARANTINE_EVENT_KIND,
			data: { sha256: "a".repeat(64), length: 10 },
		});
		expect(await quarantineTornTail(v)).toEqual({ dryRun: false, torn: null, recorded: [] });
		expect(lines(v)).toHaveLength(3);
	});

	it("a clean log: nothing to do", async () => {
		const v = await vault(2, null);
		expect(await quarantineTornTail(v)).toEqual({ dryRun: false, torn: null, recorded: [] });
	});

	for (const [name, setup] of [
		[
			"an unterminated last line that PARSES (not a torn write)",
			(v: string) => appendFileSync(logOf(v), '{"complete":true}'),
		],
		[
			"corruption BEFORE the tail",
			(v: string) => {
				const ls = lines(v);
				ls[0] = (ls[0] as string).replace('"i":0', '"i":9');
				writeFileSync(logOf(v), `${ls.join("\n")}\n{"torn`);
			},
		],
		[
			"a .meta anchor AHEAD of the chain (a truncation, not a torn tail)",
			(v: string) => {
				writeFileSync(logOf(v), `${lines(v).slice(0, 1).join("\n")}\n{"torn`);
			},
		],
		[
			"another *.jsonl segment",
			(v: string) => {
				appendFileSync(logOf(v), '{"torn');
				writeFileSync(join(auditDirOf(v), "events-old.jsonl"), "");
			},
		],
	] as const) {
		it(`refuses ${name}: nothing changed`, async () => {
			const v = await vault(2, null);
			setup(v);
			const before = readFileSync(logOf(v));
			await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
			expect(readFileSync(logOf(v)).equals(before)).toBe(true);
			expect(existsSync(join(auditDirOf(v), "quarantine"))).toBe(false);
		});
	}

	it("refuses while another writer is live (it takes the vault's writer lock)", async () => {
		const v = await vault(2);
		const live = createAuditWriter(v, { lockAtCreate: true });
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditWriterLockHeldError);
		live.release();
	});

	it("CLI: `audit quarantine-tail --dry-run --json` reports; a refusal exits non-zero", async () => {
		const v = await vault(2);
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((m: unknown) => {
			out.push(String(m));
		});
		await cli(v, { json: true }, ["quarantine-tail", "--dry-run"]);
		expect(JSON.parse(out[0] as string)).toMatchObject({
			command: "audit quarantine-tail",
			success: true,
			data: { dryRun: true, torn: { length: 16 } },
		});
		expect(process.exitCode).toBeUndefined();
		appendFileSync(logOf(v), "\n"); // now the torn line is a complete line that does not parse
		await cli(v, { json: true }, ["quarantine-tail"]);
		expect(JSON.parse(out[1] as string)).toMatchObject({ success: false });
		expect(process.exitCode).toBe(1);
	});
});
