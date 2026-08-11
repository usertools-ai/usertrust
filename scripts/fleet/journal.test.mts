/**
 * journal.test.mts — contract tests for the fleet WAL journal.
 *
 * The crash-window tests are the point of this file (spec r3 / Task 3):
 *  - INTENT without DONE must surface in pendingIntents() after reopen — that
 *    window is where a vault write may or may not have happened.
 *  - A torn FINAL line (crash mid-append) must be tolerated and REPORTED on
 *    reopen — never fatal, and never counted as INTENT or DONE.
 *
 * DONE lines in this journal are the seen-state SOURCE OF TRUTH for the whole
 * collector; any state.json elsewhere is a rebuildable cache of this file.
 */
import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { openJournal } from "./journal.mts";

const MONTH = "2026-08";

/** Fresh per-test directory, removed when the test ends. */
const tempDir = (t: TestContext): string => {
	const dir = mkdtempSync(join(tmpdir(), "fleet-journal-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
};

const journalPath = (dir: string, month: string = MONTH) => join(dir, "journal", `${month}.jsonl`);

test("DONE => seen: a message with a DONE entry is seen and no longer pending", (t) => {
	const dir = tempDir(t);
	const journal = openJournal(dir, MONTH);
	journal.intent("msg_j_001", "aaaa00000001", "in=10 out=5");
	journal.done("msg_j_001", "audit-hash-001", "fleet:aaaa00000001:msg_j_001");
	assert.deepStrictEqual(journal.seen(), new Set(["msg_j_001"]));
	assert.deepStrictEqual(journal.pendingIntents(), []);
	// seen() hands out a copy — callers must not be able to forge seen-state.
	journal.seen().add("msg_forged");
	assert.deepStrictEqual(journal.seen(), new Set(["msg_j_001"]));
});

test("INTENT without DONE => pendingIntents, not seen (the crash window)", (t) => {
	const dir = tempDir(t);
	const journal = openJournal(dir, MONTH);
	journal.intent("msg_j_a", "aaaa00000002", "in=1 out=1");
	journal.intent("msg_j_b", "bbbb00000002", "in=2 out=2");
	journal.done("msg_j_a", "audit-hash-a", "fleet:aaaa00000002:msg_j_a");
	assert.deepStrictEqual(journal.seen(), new Set(["msg_j_a"]));
	assert.deepStrictEqual(journal.pendingIntents(), [
		{ messageId: "msg_j_b", sessionHash: "bbbb00000002" },
	]);
});

test("reopen round-trips: seen + pendingIntents rebuilt from the file alone", (t) => {
	const dir = tempDir(t);
	const first = openJournal(dir, MONTH);
	first.intent("msg_j_a", "aaaa00000003", "in=1 out=1");
	first.done("msg_j_a", "audit-hash-a", "fleet:aaaa00000003:msg_j_a");
	first.intent("msg_j_b", "bbbb00000003", "in=2 out=2");
	// duplicate INTENT for the same id must not produce a duplicate pending row
	first.intent("msg_j_b", "bbbb00000003", "in=2 out=2 (retry)");

	const reopened = openJournal(dir, MONTH);
	assert.equal(reopened.tornTail, null);
	assert.deepStrictEqual(reopened.seen(), new Set(["msg_j_a"]));
	assert.deepStrictEqual(reopened.pendingIntents(), [
		{ messageId: "msg_j_b", sessionHash: "bbbb00000003" },
	]);
});

test("every append is ONE line-JSON write: the file grows on every call, each line parses with pinned keys", (t) => {
	// fsync itself is not observable from outside the process; what IS
	// observable — and asserted here — is that every intent()/done() call
	// lands in the file immediately (no buffering) as one whole JSON line.
	const dir = tempDir(t);
	const path = journalPath(dir);
	const journal = openJournal(dir, MONTH);
	let lastSize = statSync(path).size;
	const grewBy = (): number => {
		const size = statSync(path).size;
		const delta = size - lastSize;
		lastSize = size;
		return delta;
	};

	journal.intent("msg_j_a", "aaaa00000004", "in=1 out=1");
	assert.ok(grewBy() > 0, "intent append did not grow the file");
	journal.done("msg_j_a", "audit-hash-a", "fleet:aaaa00000004:msg_j_a");
	assert.ok(grewBy() > 0, "done append did not grow the file");
	journal.intent("msg_j_b", "bbbb00000004", "in=2 out=2");
	assert.ok(grewBy() > 0, "second intent append did not grow the file");

	const raw = readFileSync(path, "utf-8");
	assert.ok(raw.endsWith("\n"), "journal must end on a record boundary");
	const lines = raw.slice(0, -1).split("\n");
	assert.equal(lines.length, 3);
	assert.deepStrictEqual(Object.keys(JSON.parse(lines[0])), [
		"type",
		"messageId",
		"sessionHash",
		"meters",
	]);
	assert.deepStrictEqual(Object.keys(JSON.parse(lines[1])), [
		"type",
		"messageId",
		"auditHash",
		"costCenter",
	]);
	assert.deepStrictEqual(JSON.parse(lines[2]), {
		type: "INTENT",
		messageId: "msg_j_b",
		sessionHash: "bbbb00000004",
		meters: "in=2 out=2",
	});
});

test("torn final DONE (crash mid-write): tolerated on reopen, REPORTED, counted as neither INTENT nor DONE", (t) => {
	const dir = tempDir(t);
	const first = openJournal(dir, MONTH);
	first.intent("msg_j_a", "aaaa00000005", "in=1 out=1");
	first.done("msg_j_a", "audit-hash-a", "fleet:aaaa00000005:msg_j_a");
	first.intent("msg_j_b", "bbbb00000005", "in=2 out=2");
	// Simulate the crash: a partial DONE line for msg_j_b, no closing brace,
	// no newline — exactly what a prefix of one writeSync looks like on disk.
	const torn = '{"type":"DONE","messageId":"msg_j_b","auditHa';
	appendFileSync(journalPath(dir), torn);

	const warn = t.mock.method(console, "warn", () => {});
	const reopened = openJournal(dir, MONTH); // must NOT throw
	assert.equal(warn.mock.callCount(), 1, "torn tail must be reported on reopen");
	assert.equal(reopened.tornTail, torn);
	assert.deepStrictEqual(reopened.seen(), new Set(["msg_j_a"]), "torn DONE must not count");
	assert.deepStrictEqual(reopened.pendingIntents(), [
		{ messageId: "msg_j_b", sessionHash: "bbbb00000005" },
	]);

	// Recovery must leave a HEALTHY journal: completing the interrupted DONE
	// and reopening a third time yields clean state, and every line on disk
	// is valid line-JSON (the torn bytes were not concatenated into).
	reopened.done("msg_j_b", "audit-hash-b", "fleet:bbbb00000005:msg_j_b");
	for (const line of readFileSync(journalPath(dir), "utf-8").trimEnd().split("\n")) {
		JSON.parse(line); // throws if the torn bytes leaked into any record
	}
	const third = openJournal(dir, MONTH);
	assert.equal(third.tornTail, null);
	assert.deepStrictEqual(third.seen(), new Set(["msg_j_a", "msg_j_b"]));
	assert.deepStrictEqual(third.pendingIntents(), []);
});

test("torn final INTENT never enters pendingIntents", (t) => {
	const dir = tempDir(t);
	const first = openJournal(dir, MONTH);
	first.intent("msg_j_a", "aaaa00000006", "in=1 out=1");
	first.done("msg_j_a", "audit-hash-a", "fleet:aaaa00000006:msg_j_a");
	const torn = '{"type":"INTENT","messageId":"msg_j_c","sessionHash":"cccc0000';
	appendFileSync(journalPath(dir), torn);

	const warn = t.mock.method(console, "warn", () => {});
	const reopened = openJournal(dir, MONTH);
	assert.equal(warn.mock.callCount(), 1);
	assert.equal(reopened.tornTail, torn);
	assert.deepStrictEqual(reopened.pendingIntents(), [], "torn INTENT must not count");
	assert.deepStrictEqual(reopened.seen(), new Set(["msg_j_a"]));
});

test("complete final record missing only its newline IS counted — a strict prefix of line-JSON never parses, so parses => complete", (t) => {
	const dir = tempDir(t);
	const first = openJournal(dir, MONTH);
	first.intent("msg_j_a", "aaaa00000007", "in=1 out=1");
	// Crash torn the write between the JSON and its "\n": the record content
	// is fully present, so the vault write it describes really happened.
	appendFileSync(
		journalPath(dir),
		'{"type":"DONE","messageId":"msg_j_a","auditHash":"audit-hash-a","costCenter":"fleet:aaaa00000007:msg_j_a"}',
	);

	const reopened = openJournal(dir, MONTH);
	assert.equal(reopened.tornTail, null);
	assert.deepStrictEqual(reopened.seen(), new Set(["msg_j_a"]));
	assert.deepStrictEqual(reopened.pendingIntents(), []);

	// The repaired terminator keeps later appends off the recovered record.
	reopened.intent("msg_j_x", "dddd00000007", "in=3 out=3");
	for (const line of readFileSync(journalPath(dir), "utf-8").trimEnd().split("\n")) {
		JSON.parse(line);
	}
	const third = openJournal(dir, MONTH);
	assert.deepStrictEqual(third.pendingIntents(), [
		{ messageId: "msg_j_x", sessionHash: "dddd00000007" },
	]);
});

test("corruption that is NOT a torn tail is fatal: garbage or foreign entries throw on open", (t) => {
	const dir = tempDir(t);
	// A silently dropped DONE line becomes a double-ingest, so anything other
	// than the one crash signature (torn FINAL line) must refuse loudly.
	const interior = join(dir, "interior");
	mkdirSync(join(interior, "journal"), { recursive: true });
	writeFileSync(
		journalPath(interior),
		'{"type":"INTENT","messageId":"msg_j_a","sessionHash":"aaaa00000008","meters":"m"}\n' +
			"GARBAGE NOT JSON\n" +
			'{"type":"DONE","messageId":"msg_j_a","auditHash":"h","costCenter":"c"}\n',
	);
	assert.throws(() => openJournal(interior, MONTH), /corrupt/);

	const foreign = join(dir, "foreign");
	mkdirSync(join(foreign, "journal"), { recursive: true });
	writeFileSync(journalPath(foreign), '{"type":"NOPE","messageId":"msg_j_z"}\n');
	assert.throws(() => openJournal(foreign, MONTH), /corrupt/);
});

test("month is validated as YYYY-MM before touching the filesystem", (t) => {
	const dir = tempDir(t);
	assert.throws(() => openJournal(dir, "../escape"), /YYYY-MM/);
	assert.throws(() => openJournal(dir, "2026-8"), /YYYY-MM/);
});
