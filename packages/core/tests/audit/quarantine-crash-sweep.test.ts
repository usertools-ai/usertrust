import { createHash } from "node:crypto";
import {
	appendFileSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CRASH-POINT SWEEP for the torn-tail quarantine: the recovery must CONVERGE from a crash at ANY
 * durable step, and a refusal must change NOTHING — as properties over every step and every start
 * state, not as one case per finding.
 *
 * `node:fs` is mocked so that every MUTATING call (a create-open, a write, an fsync, a truncate, a
 * rename, a link, a mkdir, an unlink) is a numbered crash point. With `crashAt = N`, call N and every
 * mutating call after it throw: nothing from N on reaches the disk, as if the process died there.
 * The steps are not listed by hand: the sweep raises N until a run completes without reaching it,
 * so a step added to the code is swept with the rest. (A thrown crash still runs `finally` blocks,
 * but their mutating calls throw too; only reads and closes go through.)
 */
const crash = {
	active: false,
	at: 0,
	count: 0,
	crashed: false,
	ops: [] as string[],
};
const META_TMP = /\.meta\.[0-9a-f-]+\.tmp$/;
const EVIDENCE_TMP = /[\\/]quarantine[\\/]\.[0-9a-f]{64}[^\\/]*\.tmp$/;
const EVIDENCE = /[\\/]quarantine[\\/][0-9a-f]{64}-\d+\.torn$/;
function label(path: string): string {
	if (path.endsWith("events.jsonl")) return "log";
	if (path.endsWith("events.jsonl.meta")) return "meta";
	if (META_TMP.test(path)) return "meta-tmp";
	if (EVIDENCE_TMP.test(path)) return "evidence-tmp";
	if (EVIDENCE.test(path)) return "evidence";
	if (/[\\/]quarantine$/.test(path)) return "quarantine-dir";
	if (/[\\/]audit$/.test(path)) return "audit-dir";
	if (path.endsWith(".audit-writer.lock")) return "lock";
	if (path.includes("dead-letters")) return "dlq";
	return "other";
}
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	const fdPaths = new Map<number, string>();
	const step = (op: string, path: string) => {
		if (!crash.active) return;
		crash.count++;
		crash.ops.push(`${op}:${label(path)}`);
		if (crash.crashed || crash.count === crash.at) {
			crash.crashed = true;
			throw Object.assign(new Error(`EIO: injected crash at step ${crash.count} (${op})`), {
				code: "EIO",
			});
		}
	};
	const creates = (flags: unknown) =>
		typeof flags === "number"
			? (flags & fs.constants.O_CREAT) !== 0
			: typeof flags === "string" && /[wa]/.test(flags);
	const openSync = ((p: unknown, flags?: unknown, mode?: unknown) => {
		if (creates(flags)) step("create", String(p));
		const fd = (fs.openSync as (...a: unknown[]) => number)(p, flags, mode);
		fdPaths.set(fd, String(p));
		return fd;
	}) as typeof fs.openSync;
	const closeSync = ((fd: number) => {
		fdPaths.delete(fd);
		return fs.closeSync(fd);
	}) as typeof fs.closeSync;
	const writeSync = ((fd: number, ...rest: unknown[]) => {
		step("write", fdPaths.get(fd) ?? "");
		return (fs.writeSync as (...a: unknown[]) => number)(fd, ...rest);
	}) as typeof fs.writeSync;
	const fsyncSync = ((fd: number) => {
		step("fsync", fdPaths.get(fd) ?? "");
		return fs.fsyncSync(fd);
	}) as typeof fs.fsyncSync;
	const ftruncateSync = ((fd: number, len?: number) => {
		step("truncate", fdPaths.get(fd) ?? "");
		return fs.ftruncateSync(fd, len);
	}) as typeof fs.ftruncateSync;
	const renameSync = ((from: string, to: string) => {
		step("rename", String(to));
		return fs.renameSync(from, to);
	}) as typeof fs.renameSync;
	const linkSync = ((from: string, to: string) => {
		step("link", String(to));
		return fs.linkSync(from, to);
	}) as typeof fs.linkSync;
	const mkdirSync = ((p: string, o?: unknown) => {
		step("mkdir", String(p));
		return (fs.mkdirSync as (...a: unknown[]) => unknown)(p, o);
	}) as typeof fs.mkdirSync;
	const unlinkSync = ((p: string) => {
		step("unlink", String(p));
		return fs.unlinkSync(p);
	}) as typeof fs.unlinkSync;
	const wrapped = {
		openSync,
		closeSync,
		writeSync,
		fsyncSync,
		ftruncateSync,
		renameSync,
		linkSync,
		mkdirSync,
		unlinkSync,
	};
	return { ...fs, ...wrapped, default: { ...fs, ...wrapped } };
});

const { createAuditWriter } = await import("../../src/audit/chain.js");
const { AuditQuarantineRefusedError, QUARANTINE_EVENT_KIND, quarantineTornTail } = await import(
	"../../src/audit/quarantine.js"
);
const { verifyVault } = await import("../../src/audit/verify.js");
const { VAULT_DIR } = await import("../../src/shared/constants.js");

const dirs: string[] = [];
beforeEach(() => {
	// A crashed run degrades the writer, which warns and writes dead letters; keep the output quiet.
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	Object.assign(crash, { active: false, at: 0, count: 0, crashed: false, ops: [] });
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const auditDirOf = (v: string) => join(v, VAULT_DIR, "audit");
const logOf = (v: string) => join(auditDirOf(v), "events.jsonl");
const metaOf = (v: string) => `${logOf(v)}.meta`;
const qDirOf = (v: string) => join(auditDirOf(v), "quarantine");
const TORN = '{"id":"half-writ';
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
interface Line {
	kind: string;
	hash: string;
	previousHash: string;
	sequence: number;
	data: { file?: string };
}
const linesOf = (v: string): Line[] =>
	readFileSync(logOf(v), "utf-8")
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => JSON.parse(l) as Line);

function scratch(): string {
	const v = mkdtempSync(join(tmpdir(), "trust-qsweep-"));
	dirs.push(v);
	return v;
}
async function withEvents(n: number): Promise<string> {
	const v = scratch();
	const w = createAuditWriter(v);
	for (let i = 0; i < n; i++) await w.appendEvent({ kind: "t", actor: "sys", data: { i } });
	w.release();
	return v;
}
function anchorOneBehind(v: string): void {
	const head = linesOf(v).at(-1) as Line;
	writeFileSync(
		metaOf(v),
		JSON.stringify({ lastHash: head.previousHash, sequence: head.sequence - 1 }),
	);
}
/** The evidence file a cut of the log's CURRENT torn tail gets. */
const tornFile = (v: string) =>
	`quarantine/${sha256(TORN)}-${readFileSync(logOf(v)).lastIndexOf(0x0a) + 1}.torn`;

/** Everything a repair may change: the log, its anchor, and the quarantine directory, by content. */
function snapshot(v: string): string {
	const read = (p: string): string => {
		let st: ReturnType<typeof lstatSync>;
		try {
			st = lstatSync(p);
		} catch (err) {
			if ((err as { code?: string }).code === "ENOENT") return "absent";
			throw err;
		}
		if (st.isSymbolicLink()) return `symlink->${readlinkSync(p)}`;
		if (st.isDirectory()) {
			return `dir{${readdirSync(p)
				.sort()
				.map((n) => `${n}=${read(join(p, n))}`)
				.join(",")}}`;
		}
		return `file:${sha256(readFileSync(p))}:nlink=${st.nlink}`;
	};
	return JSON.stringify({ log: read(logOf(v)), meta: read(metaOf(v)), q: read(qDirOf(v)) });
}

/**
 * Every quarantine call in this file goes through here: a REFUSAL must leave the log, `.meta` and
 * `quarantine/` byte-identical, whatever the start state and whatever step it came from.
 */
async function run(v: string, opts?: { dryRun?: boolean }) {
	const before = snapshot(v);
	try {
		return await quarantineTornTail(v, opts);
	} catch (err) {
		if (err instanceof AuditQuarantineRefusedError) {
			expect(snapshot(v), `a refusal changed the vault: ${err.message}`).toBe(before);
		}
		throw err;
	}
}

/** Converged: verifies, no torn tail, anchor AT the head, exactly one record per cut and per evidence file. */
function expectConverged(v: string, cuts: number, where: string): void {
	expect(readFileSync(logOf(v), "utf-8").endsWith("\n"), `${where}: no torn tail`).toBe(true);
	expect(verifyVault(join(v, VAULT_DIR)), where).toMatchObject({ valid: true });
	const lines = linesOf(v);
	const head = lines.at(-1) as Line;
	expect(JSON.parse(readFileSync(metaOf(v), "utf-8")), `${where}: anchor at the head`).toEqual({
		lastHash: head.hash,
		sequence: head.sequence,
	});
	const files = lines.filter((l) => l.kind === QUARANTINE_EVENT_KIND).map((l) => l.data.file);
	expect(files, `${where}: one record per cut`).toHaveLength(cuts);
	expect(new Set(files).size, `${where}: no cut recorded twice`).toBe(files.length);
	const evidence = readdirSync(qDirOf(v))
		.filter((f) => f.endsWith(".torn"))
		.map((f) => `quarantine/${f}`);
	expect(evidence.sort(), `${where}: every evidence file has its record`).toEqual(
		[...(files as string[])].sort(),
	);
}

interface Start {
	name: string;
	make: () => Promise<string>;
	/** Cuts the converged chain records in all. */
	cuts: number;
}
const STARTS: Start[] = [
	{
		name: "anchor at the head",
		cuts: 1,
		make: async () => {
			const v = await withEvents(2);
			appendFileSync(logOf(v), TORN);
			return v;
		},
	},
	{
		name: "anchor ONE BEHIND",
		cuts: 1,
		make: async () => {
			const v = await withEvents(2);
			anchorOneBehind(v);
			appendFileSync(logOf(v), TORN);
			return v;
		},
	},
	{
		name: "anchor ABSENT, one event",
		cuts: 1,
		make: async () => {
			const v = await withEvents(1);
			rmSync(metaOf(v));
			appendFileSync(logOf(v), TORN);
			return v;
		},
	},
	{
		name: "anchor ABSENT, no complete line (torn bytes only)",
		cuts: 1,
		make: async () => {
			const v = scratch();
			mkdirSync(auditDirOf(v), { recursive: true });
			writeFileSync(logOf(v), TORN);
			return v;
		},
	},
	{
		name: "identical torn bytes cut a SECOND time",
		cuts: 2,
		make: async () => {
			const v = await withEvents(2);
			appendFileSync(logOf(v), TORN);
			await quarantineTornTail(v);
			const w = createAuditWriter(v);
			await w.appendEvent({ kind: "t", actor: "sys", data: { after: 1 } });
			w.release();
			appendFileSync(logOf(v), TORN);
			return v;
		},
	},
];

describe("quarantine crash-point sweep: from a crash at ANY step, the next run converges", () => {
	it("the sweep reaches every step of the repair, in order (log fsync, anchor, evidence, cut, record, anchor)", async () => {
		const v = await STARTS[1]?.make();
		Object.assign(crash, { active: true, at: Number.POSITIVE_INFINITY, count: 0, ops: [] });
		await run(v as string);
		crash.active = false;
		const order = [
			"fsync:log", // the verified log, before any head derived from it is published
			"rename:meta", // the one-behind anchor, advanced before anything is appended
			"write:evidence-tmp",
			"fsync:evidence-tmp",
			"link:evidence",
			"fsync:quarantine-dir",
			"fsync:audit-dir",
			"truncate:log",
			"fsync:log",
			"write:log", // the chained record
			"fsync:log",
			"rename:meta", // its anchor update
		];
		let at = 0;
		for (const op of crash.ops) if (op === order[at]) at++;
		expect(order.slice(at), `steps missing or out of order in ${crash.ops.join(" ")}`).toEqual([]);
	});

	for (const start of STARTS) {
		it(`start: ${start.name}`, { timeout: 120_000 }, async () => {
			let n = 1;
			for (; ; n++) {
				const v = await start.make();
				Object.assign(crash, { active: true, at: n, count: 0, crashed: false, ops: [] });
				let failure: unknown;
				try {
					await run(v);
				} catch (err) {
					failure = err;
				}
				const fired = crash.crashed;
				const reached = crash.ops[n - 1];
				Object.assign(crash, { active: false, crashed: false });
				if (!fired) {
					// Past the last step: the run itself completed.
					expect(failure, "an uninjected run completes").toBeUndefined();
					expectConverged(v, start.cuts, "uninjected run");
					break;
				}
				const where = `crash at step ${n} (${reached})`;
				// The next run must FINISH the repair — never refuse forever.
				await expect(run(v), where).resolves.toBeDefined();
				expectConverged(v, start.cuts, where);
				expect(await run(v), `${where}: then nothing is left to do`).toEqual({
					dryRun: false,
					torn: null,
					recorded: [],
				});
			}
			expect(n, "the sweep crossed every step of a full repair").toBeGreaterThan(20);
		});
	}
});

describe("quarantine: a REFUSAL changes nothing, from any start state — dry run and real run", () => {
	type Plant = (v: string) => void;
	const PLANTS: Array<[string, Plant]> = [
		[
			"a SYMLINK at the torn tail's own evidence name",
			(v) => {
				const outside = join(scratch(), "outside.txt");
				writeFileSync(outside, TORN);
				mkdirSync(qDirOf(v), { mode: 0o700 });
				symlinkSync(outside, join(auditDirOf(v), tornFile(v)));
			},
		],
		[
			"a CORRUPT file at the torn tail's own evidence name",
			(v) => {
				mkdirSync(qDirOf(v), { mode: 0o700 });
				writeFileSync(join(auditDirOf(v), tornFile(v)), "planted");
			},
		],
		["a DANGLING quarantine/ symlink", (v) => symlinkSync(join(scratch(), "not-yet"), qDirOf(v))],
		["a quarantine/ symlink to a real directory", (v) => symlinkSync(scratch(), qDirOf(v))],
		["a HARD-LINKED log", (v) => linkSync(logOf(v), join(v, "events-hardlink-elsewhere"))],
		[
			"an unrecorded cut at an offset that is no line boundary",
			(v) => {
				mkdirSync(qDirOf(v), { mode: 0o700 });
				writeFileSync(join(qDirOf(v), `${sha256("x")}-3.torn`), "x");
			},
		],
	];
	for (const anchored of ["at the head", "one behind"] as const) {
		for (const [name, plant] of PLANTS) {
			it(`${name}, anchor ${anchored}`, async () => {
				const v = await withEvents(2);
				if (anchored === "one behind") anchorOneBehind(v);
				appendFileSync(logOf(v), TORN);
				plant(v);
				await expect(run(v, { dryRun: true })).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
				await expect(run(v)).rejects.toBeInstanceOf(AuditQuarantineRefusedError);
			});
		}
	}
});
