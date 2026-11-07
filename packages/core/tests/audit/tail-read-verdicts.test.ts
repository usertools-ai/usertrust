// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE WRITER'S VERDICT ON A LARGE LOG. The open-time check and the first append decide how to
 * continue a log from its last line, and they read only the end of the file to do it. Every log
 * here is larger than that read (about 300 KB in front of the tail, or a tail or a run of blank
 * lines larger than it), and every row pins the verdict and its message as a read of the whole
 * file gives them:
 *  - a sequenced tail is continued at the next sequence, linked to it;
 *  - a tail with no usable sequence, or a non-object one, is refused (at open, and at the first
 *    append for a log that appeared after the open), its `line` the count of non-blank lines;
 *  - a tail that does not parse, and a log of blank lines, fall back to the `.meta` anchor;
 *  - a torn tail is refused at the first append, naming the bytes after the last newline.
 * Line numbers are counted here as the log is built, never by re-reading it.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalize } from "../../src/audit/canonical.js";
import {
	AuditSequencelessTailError,
	AuditTornTailError,
	type AuditWriter,
	createAuditWriter,
	createUnleasedAuditWriter,
} from "../../src/audit/chain.js";
import { GENESIS_HASH, VAULT_DIR } from "../../src/shared/constants.js";

const dirs: string[] = [];
const writers: AuditWriter[] = [];

afterEach(() => {
	for (const w of writers.splice(0)) {
		try {
			w.release();
		} catch {
			/* already released */
		}
	}
	vi.restoreAllMocks();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Events in front of the tail: about 300 KB of log, far more than the end the writer reads. */
const N = 1000;
const PAD = 150;

/**
 * One line per event, each hashed over its canonical form and linked to the one before it; the
 * first links to GENESIS. `null` in `sequences` builds an event with no `sequence` field at all.
 * `padOf(i)` is the length of the filler in event `i`.
 */
function buildChain(
	sequences: readonly (number | null)[],
	padOf: (i: number) => number = () => PAD,
): string[] {
	let previousHash = GENESIS_HASH;
	const lines: string[] = [];
	for (let i = 0; i < sequences.length; i++) {
		const seq = sequences[i];
		const event: Record<string, unknown> = {
			id: `evt-${i + 1}`,
			kind: "test.event",
			actor: "sys",
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
			previousHash,
			data: { n: i + 1, pad: "x".repeat(padOf(i)) },
		};
		if (typeof seq === "number") event.sequence = seq;
		const hash = createHash("sha256").update(canonicalize(event)).digest("hex");
		lines.push(JSON.stringify({ ...event, hash }));
		previousHash = hash;
	}
	return lines;
}

/** Sequences 1 to `n`. */
const upTo = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);

const hashOf = (line: string): string => (JSON.parse(line) as { hash: string }).hash;

/** `lines`, each terminated by `eol`, as a writer leaves a log. */
const terminated = (lines: readonly string[], eol = "\n"): string =>
	lines.map((l) => `${l}${eol}`).join("");

interface Vault {
	root: string;
	auditDir: string;
	logPath: string;
}

/** A new vault whose `events.jsonl` holds exactly `text` (no log at all when `text` is null). */
function vaultWith(text: string | null): Vault {
	const root = mkdtempSync(join(tmpdir(), "trust-tail-verdict-"));
	dirs.push(root);
	const auditDir = join(root, VAULT_DIR, "audit");
	mkdirSync(auditDir, { recursive: true });
	const logPath = join(auditDir, "events.jsonl");
	if (text !== null) writeFileSync(logPath, text);
	return { root, auditDir, logPath };
}

/** A `.meta` anchor no event in these logs carries, so a fallback to it is told apart. */
const META = { lastHash: "ab".repeat(32), sequence: 7777 };
const withMeta = (v: Vault): Vault => {
	writeFileSync(`${v.logPath}.meta`, JSON.stringify(META));
	return v;
};

/** What an open must leave exactly as it was. */
function snapshot(v: Vault): { log: Buffer; meta: Buffer | null } {
	const metaPath = `${v.logPath}.meta`;
	return {
		log: readFileSync(v.logPath),
		meta: existsSync(metaPath) ? readFileSync(metaPath) : null,
	};
}

/** Nothing was written: the log and its anchor keep their bytes; no dead letter, no lock. */
function expectNothingWritten(v: Vault, before: { log: Buffer; meta: Buffer | null }): void {
	const now = snapshot(v);
	expect(now.log.equals(before.log)).toBe(true);
	if (before.meta === null) expect(now.meta).toBeNull();
	else expect(now.meta?.equals(before.meta)).toBe(true);
	expect(existsSync(join(v.root, VAULT_DIR, "dlq"))).toBe(false);
	expect(existsSync(join(v.auditDir, ".audit-writer.lock"))).toBe(false);
}

/** What `fn` throws, or undefined. A writer it returns instead is released after the test. */
function thrownBy(fn: () => AuditWriter): unknown {
	try {
		writers.push(fn());
		return undefined;
	} catch (err) {
		return err;
	}
}

/** The open is refused as sequence-less at `line`, with today's message; nothing is written. */
function expectRefusedAtOpen(v: Vault, line: number): void {
	const before = snapshot(v);
	for (const make of [() => createAuditWriter(v.root), () => createUnleasedAuditWriter(v.root)]) {
		const err = thrownBy(make);
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toMatchObject({ logPath: v.logPath, line });
		expect((err as Error).message).toBe(new AuditSequencelessTailError(v.logPath, line).message);
		expectNothingWritten(v, before);
	}
}

/** The first event a new writer on `v` appends. */
async function appendOne(v: Vault) {
	const w = createAuditWriter(v.root);
	writers.push(w);
	return w.appendEvent({ kind: "test.next", actor: "sys", data: {} });
}

/** What the first append of a writer opened on `v` rejects with; the log keeps its bytes. */
async function appendRejection(v: Vault): Promise<unknown> {
	const before = readFileSync(v.logPath);
	vi.spyOn(console, "warn").mockImplementation(() => {});
	const w = createAuditWriter(v.root);
	writers.push(w);
	const err = await w
		.appendEvent({ kind: "test.next", actor: "sys", data: {} })
		.catch((e: unknown) => e);
	expect(readFileSync(v.logPath).equals(before)).toBe(true);
	return err;
}

describe("a large log ending in a sequenced event is continued, as before", () => {
	it("the log is far larger than the end the writer reads; it is continued at the next sequence", async () => {
		const chain = buildChain(upTo(N));
		const v = vaultWith(terminated(chain));
		expect(statSync(v.logPath).size).toBeGreaterThan(300_000);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(chain[N - 1] as string) });
	});

	it("a last event longer than the end the writer reads is continued at the next sequence", async () => {
		const chain = buildChain(upTo(N), (i) => (i === N - 1 ? 40_000 : PAD));
		const v = vaultWith(terminated(chain));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(chain[N - 1] as string) });
	});

	it("blank lines and spaces after the last event, more than the writer reads, are skipped", async () => {
		const chain = buildChain(upTo(N));
		const v = vaultWith(`${terminated(chain)}${"\n \n\t\n".repeat(3000)}`);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(chain[N - 1] as string) });
	});

	it("lines of Unicode whitespace after the last event are skipped as blank", async () => {
		const chain = buildChain(upTo(N));
		const v = vaultWith(`${terminated(chain)}${"\u00a0\n\u2028\n\ufeff\n\u3000\n".repeat(1000)}`);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(chain[N - 1] as string) });
	});

	it("a last event led by spaces or a tab still parses and is continued", async () => {
		const chain = buildChain(upTo(N));
		const last = chain[N - 1] as string;
		const v = vaultWith(terminated([...chain.slice(0, N - 1), ` \t ${last}`]));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(last) });
	});

	it("CRLF line endings, with CRLF blank lines: continued at the next sequence, as LF", async () => {
		const chain = buildChain(upTo(N));
		const v = vaultWith(`${terminated(chain, "\r\n")}\r\n\r\n`);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: N + 1, previousHash: hashOf(chain[N - 1] as string) });
	});
});

describe("a large log whose tail is not continuable is refused, numbering the line as before", () => {
	/**
	 * `chain` with blank lines (empty, spaces, tabs, a lone CR) put between its events, `eol`
	 * after each line; the non-blank line count is the number of events, counted as they go in.
	 */
	function withBlanks(chain: readonly string[], eol = "\n"): { text: string; events: number } {
		const blanks = ["", "   ", "\t", " \t ", "\r"];
		const out: string[] = [];
		let events = 0;
		for (let i = 0; i < chain.length; i++) {
			if (i % 97 === 5) out.push(blanks[i % blanks.length] as string, "");
			out.push(chain[i] as string);
			events++;
		}
		return { text: terminated(out, eol), events };
	}

	it("a sequence-less last event, blank lines scattered through the log: line is the event count", () => {
		const { text, events } = withBlanks(buildChain([...upTo(N - 1), null]));
		expect(events).toBe(N);
		expectRefusedAtOpen(vaultWith(text), N);
	});

	it("the same log with CRLF line endings is refused at the same line", () => {
		const { text, events } = withBlanks(buildChain([...upTo(N - 1), null]), "\r\n");
		expectRefusedAtOpen(vaultWith(text), events);
	});

	it("a sequence-less last event longer than the end the writer reads is refused at its line", () => {
		const chain = buildChain([...upTo(N - 1), null], (i) => (i === N - 1 ? 40_000 : PAD));
		expectRefusedAtOpen(vaultWith(`${terminated(chain)}\n \n`), N);
	});

	it("a non-object last line (42, null) is refused at its line", () => {
		for (const tail of ["42", "null"]) {
			expectRefusedAtOpen(vaultWith(terminated([...buildChain(upTo(N)), tail])), N + 1);
		}
	});

	it("a last sequence of 2.5 is refused at its line", () => {
		expectRefusedAtOpen(vaultWith(terminated(buildChain([...upTo(N - 1), 2.5]))), N);
	});

	it("a sequence-less log that appeared after the open is refused at the first append, at its line", async () => {
		const v = vaultWith(null);
		const w = createAuditWriter(v.root);
		writers.push(w);
		const { text } = withBlanks(buildChain([...upTo(N - 1), null]));
		writeFileSync(v.logPath, text);
		const before = readFileSync(v.logPath);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const err = await w
			.appendEvent({ kind: "test.next", actor: "sys", data: {} })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuditSequencelessTailError);
		expect(err).toMatchObject({ logPath: v.logPath, line: N });
		expect((err as Error).message).toBe(new AuditSequencelessTailError(v.logPath, N).message);
		expect(w.isDegraded()).toBe(true);
		expect(readFileSync(v.logPath).equals(before)).toBe(true);
	});
});

describe("a large log whose tail does not parse, or holds nothing, falls back as before", () => {
	it("a last line that does not parse: the .meta anchor is the tail", async () => {
		const v = withMeta(vaultWith(terminated([...buildChain(upTo(N)), "NOT_VALID_JSON"])));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: META.sequence + 1, previousHash: META.lastHash });
	});

	it("a last event led by a no-break space does not parse: the .meta anchor is the tail", async () => {
		const chain = buildChain(upTo(N));
		const v = withMeta(vaultWith(terminated([...chain.slice(0, N - 1), `\u00a0${chain[N - 1]}`])));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: META.sequence + 1, previousHash: META.lastHash });
	});

	it("a sequence-less last event led by a no-break space is not refused: it does not parse", async () => {
		const chain = buildChain([...upTo(N - 1), null]);
		const v = withMeta(vaultWith(terminated([...chain.slice(0, N - 1), `\u00a0${chain[N - 1]}`])));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: META.sequence + 1, previousHash: META.lastHash });
	});

	it("an empty log starts at 1, linked to GENESIS", async () => {
		const e = await appendOne(vaultWith(""));
		expect(e).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
	});

	it("a log of blank lines larger than the end the writer reads starts at 1", async () => {
		const v = vaultWith("\n \n\t\n".repeat(100_000));
		expect(statSync(v.logPath).size).toBeGreaterThan(300_000);
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: 1, previousHash: GENESIS_HASH });
	});

	it("a log of blank lines larger than the end the writer reads, with a .meta anchor: the anchor", async () => {
		const v = withMeta(vaultWith("\n \n\t\n".repeat(100_000)));
		const e = await appendOne(v);
		expect(e).toMatchObject({ sequence: META.sequence + 1, previousHash: META.lastHash });
	});
});

describe("a large log ending in a torn line is refused at the first append, as before", () => {
	const torns: ReadonlyArray<[string, string]> = [
		["a half-written event", '{"id":"half-writ'],
		["multi-byte characters", '{"id":"\u20ac\u20ac\u{1f600}'],
		["bytes longer than the end the writer reads", `{"pad":"${"z".repeat(20_000)}`],
		["spaces only", "  "],
		["a sequence-less event with no newline after it", buildChain([null])[0] as string],
	];
	for (const [label, torn] of torns) {
		it(`a torn tail of ${label}: the open succeeds, the append names its bytes`, async () => {
			const v = vaultWith(`${terminated(buildChain(upTo(N)))}${torn}`);
			const err = await appendRejection(v);
			expect(err).toBeInstanceOf(AuditTornTailError);
			const bytes = Buffer.byteLength(torn);
			expect((err as Error).message).toBe(new AuditTornTailError(v.logPath, bytes).message);
			expect((err as Error).message).toContain(`(${bytes} byte(s) after its last newline)`);
		});
	}

	it("a log with no newline at all, larger than the end the writer reads, is torn whole", async () => {
		const torn = `{"pad":"${"z".repeat(300_000)}`;
		const v = vaultWith(torn);
		const err = await appendRejection(v);
		expect(err).toBeInstanceOf(AuditTornTailError);
		expect((err as Error).message).toBe(
			new AuditTornTailError(v.logPath, Buffer.byteLength(torn)).message,
		);
	});
});
