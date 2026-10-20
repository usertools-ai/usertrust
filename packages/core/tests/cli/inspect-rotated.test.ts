import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditWriter } from "../../src/audit/chain.js";
import { run } from "../../src/cli/inspect.js";

/**
 * `usertrust inspect` on a ROTATED vault. The chain verdict, the event count, the latest hash, the
 * Merkle root and the transactions table must all come from ONE vault-wide reading (every `*.jsonl`
 * segment, ordered by `sequence`), the reading `usertrust verify` gives its verdict on. Checking the
 * live `events.jsonl` alone printed INTEGRITY FAILURE on a rotated vault that verifies: its first
 * event links to the previous segment, not to GENESIS, and the `.meta` anchor counts every event.
 */

interface InspectJson {
	data: {
		chain: { events: number; valid: boolean; latestHash: string; errors: string[] };
		merkleRoot: string | null;
		transactions: { model: string; receipt: string }[];
	};
}

describe("usertrust inspect: rotated audit segments", () => {
	let tempDir: string;
	let auditDir: string;
	let logOutput: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-inspect-rot-"));
		auditDir = join(tempDir, ".usertrust", "audit");
		logOutput = [];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.resetModules();
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Nine events in ONE `events.jsonl` (+ its `.meta`), written by the real writer. */
	async function writeNine(): Promise<string[]> {
		const writer = createAuditWriter(tempDir);
		for (let i = 1; i <= 9; i++) {
			await writer.appendEvent({
				kind: "llm_call",
				actor: "test",
				data: { model: `model-${i}`, cost: i, transferId: `tx_${i}` },
			});
		}
		writer.release();
		return readFileSync(join(auditDir, "events.jsonl"), "utf-8").trim().split("\n");
	}

	/** Re-cut the nine lines into segment files, as a rotation would: the `.meta` anchor stays. */
	function cut(lines: string[], files: [name: string, from: number, to: number][]): void {
		unlinkSync(join(auditDir, "events.jsonl"));
		for (const [name, from, to] of files) {
			writeFileSync(join(auditDir, name), `${lines.slice(from - 1, to).join("\n")}\n`);
		}
	}

	async function inspectJson(): Promise<InspectJson["data"]> {
		logOutput = [];
		await run(tempDir, { json: true });
		return (JSON.parse(logOutput.at(-1) as string) as InspectJson).data;
	}

	// picocolors turns colour on when `CI` is set, so the same row printed plain locally and wrapped in
	// SGR codes in CI: assert on the text, never on whether a line happened to be coloured.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips SGR codes (ESC [ ... m) from captured output
	const SGR = /\x1b\[[0-9;]*m/g;

	async function inspectTable(): Promise<string> {
		logOutput = [];
		await run(tempDir);
		return logOutput.join("\n").replace(SGR, "");
	}

	it("one rotation (events-0001.jsonl + events.jsonl): valid, all events, and the single file's hash and root", async () => {
		const lines = await writeNine();
		const single = await inspectJson();
		expect(single.chain).toMatchObject({ events: 9, valid: true });

		cut(lines, [
			["events-0001.jsonl", 1, 4],
			["events.jsonl", 5, 9],
		]);
		const rotated = await inspectJson();
		expect(rotated.chain).toMatchObject({
			events: 9,
			valid: true,
			latestHash: single.chain.latestHash,
			errors: [],
		});
		expect(rotated.merkleRoot).toBe(single.merkleRoot);
		expect(rotated.merkleRoot).not.toBeNull();
		expect(rotated.transactions.map((t) => t.receipt)).toEqual(
			single.transactions.map((t) => t.receipt),
		);

		const table = await inspectTable();
		expect(table).toContain("Chain: 9 events | Integrity: SHA-256 verified");
		expect(table).not.toContain("INTEGRITY FAILURE");
		expect(table).not.toContain("WARNING: Chain integrity check failed!");
	});

	it("two rotations (three files): valid, all events, and the single file's hash and root", async () => {
		const lines = await writeNine();
		const single = await inspectJson();

		cut(lines, [
			["events-0001.jsonl", 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		const rotated = await inspectJson();
		expect(rotated.chain).toMatchObject({
			events: 9,
			valid: true,
			latestHash: single.chain.latestHash,
			errors: [],
		});
		expect(rotated.merkleRoot).toBe(single.merkleRoot);

		const table = await inspectTable();
		expect(table).toContain("Chain: 9 events | Integrity: SHA-256 verified");
		expect(table).not.toContain("WARNING: Chain integrity check failed!");
	});

	it("a missing MIDDLE segment is a failure that NAMES the absent range and both neighbouring files", async () => {
		const lines = await writeNine();
		cut(lines, [
			["events-0001.jsonl", 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		unlinkSync(join(auditDir, "events-0002.jsonl"));

		const named =
			"audit segment missing: events 4..6 are absent between events-0001.jsonl (ends at 3) and events.jsonl (starts at 7)";
		const data = await inspectJson();
		expect(data.chain.valid).toBe(false);
		expect(data.chain.events).toBe(6);
		expect(data.chain.errors).toContain("Sequence gap: event 7 follows 3 (segment/event deletion)");
		expect(data.chain.errors).toContain(named);

		const table = await inspectTable();
		const out = table.split("\n");
		const warning = out.findIndex((l) => l.includes("WARNING: Chain integrity check failed!"));
		expect(warning).toBeGreaterThan(-1);
		expect(out.slice(warning + 1)).toContain(`  - ${named}`);
		expect(out.slice(warning + 1)).toContain(
			"  - Sequence gap: event 7 follows 3 (segment/event deletion)",
		);
	});

	it("a gap is named from the verdict's own sequences, not each file's first and last lines", async () => {
		const lines = await writeNine();
		// Out of order inside the older segment (1, 4, 2) and 3 and 5 absent: a name built from the file's
		// physical first and last lines said "events 3..5 are absent" although event 4 exists.
		unlinkSync(join(auditDir, "events.jsonl"));
		const [e1, e2, , e4, , e6, e7] = lines as [
			string,
			string,
			string,
			string,
			string,
			string,
			string,
		];
		writeFileSync(join(auditDir, "events-0001.jsonl"), `${[e1, e4, e2].join("\n")}\n`);
		writeFileSync(join(auditDir, "events.jsonl"), `${[e6, e7].join("\n")}\n`);

		const data = await inspectJson();
		expect(data.chain.valid).toBe(false);
		expect(data.chain.errors).toContain(
			"audit events missing: event 3 is absent inside events-0001.jsonl (between 2 and 4)",
		);
		expect(data.chain.errors).toContain(
			"audit segment missing: event 5 is absent between events-0001.jsonl (ends at 4) and events.jsonl (starts at 6)",
		);
		expect(data.chain.errors.some((e) => e.includes("3..5"))).toBe(false);
	});

	it("a duplicated sequence is not turned into an impossible 'missing' range", async () => {
		const lines = await writeNine();
		// events.jsonl repeats event 3: the verdict says "Sequence gap: event 3 follows 3"; nothing is absent.
		cut(lines, [
			["events-0001.jsonl", 1, 3],
			["events.jsonl", 3, 9],
		]);
		const data = await inspectJson();
		expect(data.chain.valid).toBe(false);
		expect(data.chain.errors.some((e) => e.startsWith("Sequence gap:"))).toBe(true);
		expect(data.chain.errors.some((e) => e.includes("missing"))).toBe(false);
	});

	it("a sequence present in two segments is not pinned on whichever file was read first", async () => {
		const lines = await writeNine();
		// events.jsonl holds 1 and 3 (2 absent); another segment also holds 1. Reading events.jsonl first
		// and keeping the first file per sequence said "event 2 is absent inside events.jsonl".
		unlinkSync(join(auditDir, "events.jsonl"));
		const [e1, , e3] = lines as [string, string, string];
		writeFileSync(join(auditDir, "events.jsonl"), `${[e1, e3].join("\n")}\n`);
		writeFileSync(join(auditDir, "events-0001.jsonl"), `${e1}\n`);

		const data = await inspectJson();
		expect(data.chain.valid).toBe(false);
		expect(data.chain.errors).toContain("audit events missing: event 2 is absent");
		expect(data.chain.errors.some((e) => e.includes("absent inside"))).toBe(false);
		expect(data.chain.errors.some((e) => e.includes("absent between"))).toBe(false);
	});

	it("a hostile segment file name (ESC + a C1 byte): the table shows `?`, --json keeps the bytes escaped", async () => {
		const lines = await writeNine();
		const hostile = "events-\x1b[2J\x9b0001.jsonl";
		cut(lines, [
			[hostile, 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		unlinkSync(join(auditDir, "events-0002.jsonl"));

		const named = (name: string) =>
			`audit segment missing: events 4..6 are absent between ${name} (ends at 3) and events.jsonl (starts at 7)`;
		const data = await inspectJson();
		// The field parses back to the vault's real file name: evidence is not replaced by `?`.
		expect(data.chain.errors).toContain(named(hostile));
		const json = logOutput.join("\n");
		expect(json).not.toContain("\x1b");
		expect(json).not.toContain("\x9b");
		expect(json).toContain("\\u001b[2J\\u009b0001");

		const table = await inspectTable();
		expect(table).toContain(`  - ${named("events-?[2J?0001.jsonl")}`);
		expect(table).not.toContain("\x1b[2J");
		expect(table).not.toContain("\x9b");
	});

	it("a bidi override (U+202E) and a zero-width space in a segment name print as `?` in the table", async () => {
		const lines = await writeNine();
		const hostile = "events-\u202e\u200b0001.jsonl";
		cut(lines, [
			[hostile, 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		unlinkSync(join(auditDir, "events-0002.jsonl"));

		const table = await inspectTable();
		expect(table).toContain(
			"  - audit segment missing: events 4..6 are absent between events-??0001.jsonl (ends at 3) and events.jsonl (starts at 7)",
		);
		expect(table).not.toContain("\u202e");
		expect(table).not.toContain("\u200b");
	});

	it("--json escapes a bidi override and a supplementary-plane tag character, and parses back to the exact name", async () => {
		const lines = await writeNine();
		const hostile = "events-\u202e\u{e0041}0001.jsonl";
		cut(lines, [
			[hostile, 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		unlinkSync(join(auditDir, "events-0002.jsonl"));

		const data = await inspectJson();
		const raw = logOutput.join("\n");
		// Display-safe on the wire, and lossless: the field is the vault's own text once parsed.
		expect(raw).not.toContain("\u202e");
		expect(raw).not.toContain("\u{e0041}");
		expect(raw).toContain("\\u202e\\udb40\\udc41");
		expect(data.chain.errors.some((e) => e.includes(hostile))).toBe(true);
	});

	it("with colour forced on (as `CI` does), the error lines are coloured and carry the same text", async () => {
		const lines = await writeNine();
		cut(lines, [
			["events-0001.jsonl", 1, 3],
			["events-0002.jsonl", 4, 6],
			["events.jsonl", 7, 9],
		]);
		unlinkSync(join(auditDir, "events-0002.jsonl"));

		// picocolors is external to vitest's module graph, so its env read cannot be re-run: swap in a
		// colour-enabled instance, which is what `CI=1` gives the real one.
		vi.resetModules();
		vi.doMock("picocolors", async () => {
			const mod = await vi.importActual<typeof import("picocolors")>("picocolors");
			// A CommonJS module: the namespace's `default` is the module itself under Node's interop.
			const real = (mod as { default?: typeof mod }).default ?? mod;
			return { default: real.createColors(true) };
		});
		const { run: colouredRun } = await import("../../src/cli/inspect.js");
		logOutput = [];
		await colouredRun(tempDir);
		const raw = logOutput.join("\n");
		const named =
			"audit segment missing: events 4..6 are absent between events-0001.jsonl (ends at 3) and events.jsonl (starts at 7)";
		expect(raw).toContain("\x1b[31m");
		vi.doUnmock("picocolors");
		expect(raw.replace(SGR, "").split("\n")).toContain(`  - ${named}`);
	});

	it("the vault reading's own errors are scrubbed in the table too: a malformed line in a hostile-named segment", async () => {
		// `verifyVault` scrubs a segment's file name where its own errors quote it (both verifiers do,
		// in their mirrored walk), and inspect still scrubs every line it prints, not only the ones it
		// composes.
		const lines = await writeNine();
		const hostile = "events-\x1b]0;pwned\x07\x9b0001.jsonl";
		cut(lines, [
			[hostile, 1, 4],
			["events.jsonl", 5, 9],
		]);
		writeFileSync(join(auditDir, hostile), `${lines.slice(0, 4).join("\n")}\n{torn\n`);

		const data = await inspectJson();
		expect(data.chain.valid).toBe(false);
		// --json carries the walk's own error as the walk wrote it, the name already scrubbed.
		expect(data.chain.errors).toContain("malformed JSON (events-?]0;pwned??0001.jsonl:5)");
		expect(logOutput.join("\n")).not.toContain("\x1b");
		const table = await inspectTable();
		expect(table).toContain("  - malformed JSON (events-?]0;pwned??0001.jsonl:5)");
		expect(table).not.toContain("\x1b]0;pwned");
		expect(table).not.toContain("\x9b");
	});

	it("only rotated segments and no events.jsonl: not an empty vault", async () => {
		const lines = await writeNine();
		const single = await inspectJson();
		cut(lines, [
			["events-0001.jsonl", 1, 5],
			["events-0002.jsonl", 6, 9],
		]);

		const data = await inspectJson();
		expect(data.chain).toMatchObject({
			events: 9,
			valid: true,
			latestHash: single.chain.latestHash,
			errors: [],
		});
		expect(data.merkleRoot).toBe(single.merkleRoot);
		expect(data.transactions).toHaveLength(9);

		const table = await inspectTable();
		expect(table).toContain("Chain: 9 events | Integrity: SHA-256 verified");
		expect(table).not.toContain("No transactions recorded");
	});

	it("a single-file vault keeps its existing answer (count, verdict, latest hash = the .meta head)", async () => {
		await writeNine();
		const meta = JSON.parse(readFileSync(join(auditDir, "events.jsonl.meta"), "utf-8")) as {
			lastHash: string;
			sequence: number;
		};
		const data = await inspectJson();
		expect(data.chain).toMatchObject({
			events: 9,
			valid: true,
			latestHash: meta.lastHash,
		});
		expect(meta.sequence).toBe(9);
		expect(data.transactions).toHaveLength(9);
		const table = await inspectTable();
		expect(table).toContain("Chain: 9 events | Integrity: SHA-256 verified");
	});
});
