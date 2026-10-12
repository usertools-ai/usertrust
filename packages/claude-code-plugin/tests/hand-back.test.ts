// A transcript hold is claimed (`<hold>.json` → `<hold>.settling`) before its settle is built.
// When the server's capabilities read as unknown only once the body is being built, nothing
// is sent, and the hold is handed back (`.settling` → `.json`) for a later settle point. These
// rows pin both endings of that hand-back: it works (the hold is untouched, as said), or it
// fails, and then nothing may say the hold was handed back or left untouched.
//
// The preflight and the body read the capabilities through one cached probe, so a hook process
// cannot reach this path through the HTTP harness: the capability read is replaced here, in
// process, answering known for the preflight and unknown for the body.
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({
	calls: 0,
	/** Runs as the body's capability read starts: after the claim, before the hand-back. */
	beforeBody: null as null | (() => Promise<void>),
}));

vi.mock("../hooks/lib.mjs", async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>;
	return {
		...actual,
		// Known (the server prices the 1-hour share) for the preflight; unknown for the body.
		refreshUnknownServerCapabilities: async () => {
			probe.calls += 1;
			if (probe.calls === 1) return new Set(["cache-write-1h"]);
			await probe.beforeBody?.();
			return null;
		},
	};
});

// Imported by path: the hooks are untyped JavaScript.
const LIB = join(import.meta.dirname, "..", "hooks", "lib.mjs");
const TRANSCRIPT = join(import.meta.dirname, "..", "hooks", "transcript.mjs");

const SESSION = "55555555-2222-4333-8444-666666666666";
/** A transcript hold with one assigned message whose usage carries a 1-hour share. */
const WINDOW = {
	usage: "transcript",
	holdModel: "claude-sonnet-4-6",
	assignedIds: ["msg_a"],
	inputTokens: 5,
	outputTokens: 6,
	cacheReadTokens: 0,
	cacheWriteTokens: 40,
	cacheWrite1hTokens: 40,
};

type WatchRecord = Record<string, unknown>;

let stateDir: string;
let stderr: string[];
let livePath: string;

beforeEach(async () => {
	stateDir = await mkdtemp(join(tmpdir(), "utcc-handback-"));
	process.env.UT_CC_STATE_DIR = stateDir;
	probe.calls = 0;
	probe.beforeBody = null;
	stderr = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
		stderr.push(String(chunk));
		return true;
	});
	const lib = await import(LIB);
	// A hook's budget counts from its start: this row's, not the module's first import.
	lib.launch({ payload: null, startedAt: Date.now() });
	livePath = lib.holdFilePath(SESSION, "main", { toolUseId: "tu_1", transferId: "tx_1" });
});
afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.UT_CC_STATE_DIR;
});

async function seedHold(fields: Record<string, unknown> = {}): Promise<string> {
	const body = JSON.stringify({
		gate: 1,
		toolUseId: "tu_1",
		transferId: "tx_1",
		agentId: "main",
		startedAt: new Date().toISOString(),
		...WINDOW,
		...fields,
	});
	await writeFile(livePath, body, { mode: 0o600 });
	return body;
}

/** Something in the hold's place once it is claimed: the hand-back's rename cannot land. */
function blockHandBack(): void {
	probe.beforeBody = async () => {
		await mkdir(livePath);
		await writeFile(join(livePath, "occupant"), "");
	};
}

async function watchRecords(): Promise<WatchRecord[]> {
	try {
		const text = await readFile(join(stateDir, "watch.jsonl"), "utf-8");
		return text
			.split("\n")
			.filter((line) => line !== "")
			.map((line) => JSON.parse(line) as WatchRecord);
	} catch {
		return [];
	}
}

async function holdFiles(): Promise<string[]> {
	return (await readdir(stateDir)).filter((name) => name.includes("tx_1")).sort();
}

const settlingPath = () => `${livePath.slice(0, -".json".length)}.settling`;

describe("a claimed transcript hold whose settle was not sent", () => {
	it("handed back: the hold file is live again, as it was, and nothing is left claimed", async () => {
		const body = await seedHold();
		const { settleTranscriptHold } = await import(TRANSCRIPT);
		const { listPending } = await import(LIB);
		const [entry] = await listPending(SESSION, "main");
		const result = await settleTranscriptHold(SESSION, entry);
		expect(probe.calls).toBe(2);
		expect(result).toMatchObject({ outcome: "deferred", unsent: true });
		expect(result.reason).toContain("the hold is untouched");
		expect(result.handBack).toBeUndefined();
		expect(await readFile(livePath, "utf-8")).toBe(body);
		expect(await holdFiles()).toEqual([`${SESSION}__main__tu_1.tx_1.json`]);
	});

	it("handed back, at Stop: said as deferred and untouched, its gap `deferred`", async () => {
		await seedHold();
		const { settleAssignedHolds } = await import(TRANSCRIPT);
		await settleAssignedHolds(SESSION, "main");
		expect(stderr.join("")).toContain("usertrust: leftover hold tx_1 deferred — ");
		expect(stderr.join("")).toContain("the hold is untouched");
		const records = await watchRecords();
		expect(records).toMatchObject([
			{ kind: "gap", phase: "settle", outcome: "deferred", transferId: "tx_1" },
		]);
		expect(records[0]?.handBack).toBeUndefined();
		expect(await holdFiles()).toEqual([`${SESSION}__main__tu_1.tx_1.json`]);
	});

	it.each([
		["no key", "claimed", {}],
		["a key", "unresolved", { idempotencyKey: "key_1" }],
	] as const)(
		"not handed back (%s): the result says the hold stays claimed, %s, never deferred or untouched",
		async (_, outcome, fields) => {
			await seedHold(fields);
			blockHandBack();
			const { settleTranscriptHold } = await import(TRANSCRIPT);
			const { listPending } = await import(LIB);
			const [entry] = await listPending(SESSION, "main");
			const result = await settleTranscriptHold(SESSION, entry);
			expect(probe.calls).toBe(2);
			expect(result).toMatchObject({
				outcome,
				unsent: true,
				handBack: "failed",
				holdEnded: false,
			});
			expect(typeof result.code).toBe("string");
			expect(result.reason).toContain("the settle was not sent");
			expect(result.reason).toContain(`could not be handed back (${result.code})`);
			expect(result.reason).toContain("it stays claimed as .settling");
			expect(result.reason).not.toContain("untouched");
			// Claimed it stays: the .settling file the journal reads, and no hold file in its place.
			expect((await stat(settlingPath())).isFile()).toBe(true);
			expect((await stat(livePath)).isDirectory()).toBe(true);
		},
	);

	it("not handed back, at Stop: said on stderr with its code, and written down as a `claimed` gap that says so", async () => {
		await seedHold();
		blockHandBack();
		const { settleAssignedHolds } = await import(TRANSCRIPT);
		await settleAssignedHolds(SESSION, "main");
		const said = stderr.join("");
		expect(said).toMatch(
			/usertrust: leftover hold tx_1 claimed — the settle was not sent \(the server's capabilities are unknown\), and the hold could not be handed back \(E[A-Z]+\): it stays claimed as \.settling; its usage may be unrecorded/,
		);
		expect(said).not.toContain("deferred");
		expect(said).not.toContain("untouched");
		const records = await watchRecords();
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			kind: "gap",
			phase: "settle",
			outcome: "claimed",
			transferId: "tx_1",
			handBack: "failed",
		});
		expect(records[0]?.code).toMatch(/^E[A-Z]+$/);
		expect(String(records[0]?.reason)).toContain("could not be handed back");
		expect(String(records[0]?.reason)).not.toContain("untouched");
		expect((await stat(settlingPath())).isFile()).toBe(true);
	});
});
