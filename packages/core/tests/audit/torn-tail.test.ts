import { createHash } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
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
const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const TORN = '{"id":"half-writ';

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
		const sha = sha256("torn-bytes");
		mkdirSync(join(auditDirOf(v), "quarantine"));
		writeFileSync(join(auditDirOf(v), "quarantine", `${sha}.torn`), "torn-bytes");
		expect((await quarantineTornTail(v)).recorded).toEqual([sha]);
		expect(JSON.parse(lines(v).at(-1) as string)).toMatchObject({
			kind: QUARANTINE_EVENT_KIND,
			data: { sha256: sha, length: 10 },
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

describe("#196 r1: quarantine evidence is never written through a link, and never trusted by its name", () => {
	it("P1: a quarantine/ that is a SYMLINK is refused — nothing written through it, the log untouched", async () => {
		const v = await vault(2);
		const elsewhere = mkdtempSync(join(tmpdir(), "trust-elsewhere-"));
		dirs.push(elsewhere);
		symlinkSync(elsewhere, join(auditDirOf(v), "quarantine"));
		const before = readFileSync(logOf(v));
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
	});

	it("P1: an evidence path planted as a SYMLINK is refused — the link target is never written", async () => {
		const v = await vault(2);
		const victim = join(mkdtempSync(join(tmpdir(), "trust-victim-")), "victim.txt");
		dirs.push(join(victim, ".."));
		writeFileSync(victim, "original");
		mkdirSync(join(auditDirOf(v), "quarantine"), { mode: 0o700 });
		symlinkSync(victim, join(auditDirOf(v), "quarantine", `${sha256(TORN)}.torn`));
		const before = readFileSync(logOf(v));
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
		expect(readFileSync(victim, "utf-8")).toBe("original");
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
	});

	it("an EXISTING regular evidence file whose bytes hash to its name is accepted (idempotent re-run)", async () => {
		const v = await vault(2);
		mkdirSync(join(auditDirOf(v), "quarantine"), { mode: 0o700 });
		writeFileSync(join(auditDirOf(v), "quarantine", `${sha256(TORN)}.torn`), TORN);
		const r = await quarantineTornTail(v);
		expect(r.recorded).toEqual([sha256(TORN)]);
		expect(verifyVault(join(v, VAULT_DIR)).valid).toBe(true);
	});

	it("an EXISTING evidence file with OTHER bytes under the torn tail's name is refused", async () => {
		const v = await vault(2);
		mkdirSync(join(auditDirOf(v), "quarantine"), { mode: 0o700 });
		writeFileSync(join(auditDirOf(v), "quarantine", `${sha256(TORN)}.torn`), "planted");
		const before = readFileSync(logOf(v));
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
		expect(readFileSync(logOf(v)).equals(before)).toBe(true);
	});

	it("P2: an orphan whose bytes do NOT hash to its name is refused, never recorded", async () => {
		const v = await vault(2, null);
		mkdirSync(join(auditDirOf(v), "quarantine"));
		writeFileSync(join(auditDirOf(v), "quarantine", `${"a".repeat(64)}.torn`), "torn-bytes");
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
		expect(lines(v)).toHaveLength(2);
	});

	it("P2: a *.torn file not named <sha256>.torn is refused", async () => {
		const v = await vault(2, null);
		mkdirSync(join(auditDirOf(v), "quarantine"));
		writeFileSync(join(auditDirOf(v), "quarantine", "../../x.torn".replace(/\//g, "_")), "x");
		await expect(quarantineTornTail(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
	});

	it("the quarantine directory and evidence are private (0700 / 0600) and the evidence is a regular file", async () => {
		const v = await vault(2);
		const r = await quarantineTornTail(v);
		const q = lstatSync(join(auditDirOf(v), "quarantine"));
		const e = lstatSync(join(auditDirOf(v), r.torn?.file as string));
		expect(q.isDirectory() && !q.isSymbolicLink()).toBe(true);
		expect(q.mode & 0o777).toBe(0o700);
		expect(e.isFile()).toBe(true);
		expect(e.mode & 0o777).toBe(0o600);
	});
});

describe("#196 r1 P2: a dry run is READ-ONLY", () => {
	it("on a path with no vault: refuses, and creates NOTHING (no .usertrust, no lock)", async () => {
		const empty = mkdtempSync(join(tmpdir(), "trust-novault-"));
		dirs.push(empty);
		await expect(quarantineTornTail(empty, { dryRun: true })).rejects.toBeInstanceOf(
			AuditQuarantineRefusedError,
		);
		expect(readdirSync(empty)).toEqual([]);
	});

	it("a REAL run on a path with no vault also refuses instead of creating one", async () => {
		const empty = mkdtempSync(join(tmpdir(), "trust-novault-"));
		dirs.push(empty);
		await expect(quarantineTornTail(empty)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
		expect(readdirSync(empty)).toEqual([]);
	});

	it("does not take the writer lock: it reports even while another writer is live", async () => {
		const v = await vault(2);
		const live = createAuditWriter(v, { lockAtCreate: true });
		try {
			const r = await quarantineTornTail(v, { dryRun: true });
			expect(r.torn).toMatchObject({ length: 16 });
		} finally {
			live.release();
		}
	});
});

describe("#196 r1 P2: vault-derived text is scrubbed before it reaches the terminal", () => {
	it("a segment name carrying an ESC sequence is printed with the control bytes replaced", async () => {
		const v = await vault(2);
		writeFileSync(join(auditDirOf(v), "evil\u001b[2J\u001b]0;pwn\u0007.jsonl"), "");
		const out: string[] = [];
		vi.spyOn(console, "log").mockImplementation((m: unknown) => {
			out.push(String(m));
		});
		await cli(v, {}, ["quarantine-tail"]);
		expect(process.exitCode).toBe(1);
		const printed = out.join("\n");
		expect(printed).toMatch(/evil\?\[2J\?\]0;pwn\?\.jsonl/);
		const controls = [...printed].filter((ch) => {
			const c = ch.codePointAt(0) as number;
			return (c <= 0x1f && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);
		});
		expect(controls).toEqual([]);
	});
});
