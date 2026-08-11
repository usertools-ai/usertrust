/**
 * parse.test.mts — contract tests for the fleet transcript parser.
 *
 * The two load-bearing assertions (spec r2):
 *  - ALLOWLIST: every emitted record has EXACTLY the FleetRecord keys — the
 *    Object.keys deep-equal below IS the privacy contract. The expected list is
 *    hard-coded here on purpose; importing it from the implementation would
 *    make the test self-affirming.
 *  - QUIESCENCE: file-mtime age is the ONLY signal. The A→B→A interleave
 *    fixture exists because a "later different id means A is final" shortcut
 *    was reviewed out (r2/C2) — do not reintroduce it.
 *
 * Fixtures are hand-written usage-metadata-only shapes (never copied from real
 * transcripts), so every expected number below is pinned literally.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isQuiescent, parseTranscriptFile, QUIESCENCE_MS } from "./parse.mts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string) => join(FIXTURES, name);

/** The privacy contract: exactly these keys, in construction order, nothing else. */
const FLEET_RECORD_KEYS = [
	"messageId",
	"model",
	"sessionHash",
	"occurredAt",
	"isSidechain",
	"speed",
	"inputTokens",
	"outputTokens",
	"cacheReadTokens",
	"cacheWrite5m",
	"cacheWrite1h",
];

/** Spec-pinned session hash: sha256(sessionId) hex, first 12 chars — recomputed here from the spec, not the implementation. */
const sha12 = (sessionId: string) =>
	createHash("sha256").update(sessionId).digest("hex").slice(0, 12);

/** nowMs far enough past the fixture's mtime that the file is quiescent. */
const quiescentNow = (path: string) => statSync(path).mtimeMs + QUIESCENCE_MS + 60_000;
/** nowMs so close to mtime the file must be treated as still streaming. */
const freshNow = (path: string) => statSync(path).mtimeMs + 1_000;

test("streaming duplicate id: last-wins, totals equal the FINAL line", () => {
	const path = fixture("streaming-duplicate.jsonl");
	const { records, deferred } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(deferred, 0);
	assert.equal(records.length, 1);
	// Full-record pin: the whole record comes from the LAST msg_fix_a_001 line.
	assert.deepStrictEqual(records[0], {
		messageId: "msg_fix_a_001",
		model: "claude-opus-5",
		sessionHash: sha12("fixture-session-a"),
		occurredAt: "2026-08-10T12:00:06.000Z",
		isSidechain: false,
		speed: "standard",
		inputTokens: 7,
		outputTokens: 42,
		cacheReadTokens: 1200,
		cacheWrite5m: 300,
		cacheWrite1h: 50,
	});
});

test("A→B→A interleave: final A wins even though B appeared in between", () => {
	// r2/C2: seeing a DIFFERENT id (B) after A proves nothing about A being
	// final — the third line rewrites A with larger usage. Only the final A
	// line's totals may survive.
	const path = fixture("interleave-aba.jsonl");
	const { records, deferred } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(deferred, 0);
	assert.equal(records.length, 2);
	const a = records.find((r) => r.messageId === "msg_fix_b_aaa");
	const b = records.find((r) => r.messageId === "msg_fix_b_bbb");
	assert.ok(a, "record A missing");
	assert.ok(b, "record B missing");
	assert.equal(a.outputTokens, 99); // final A line, not the first (9)
	assert.equal(a.occurredAt, "2026-08-10T12:10:05.000Z");
	assert.equal(a.inputTokens, 10);
	assert.equal(b.outputTokens, 17); // B untouched by A's rewrite
	assert.equal(b.cacheWrite5m, 25);
	assert.equal(b.cacheWrite1h, 5);
});

test("fresh mtime defers ALL ids — quiescence is file-mtime age only", () => {
	const aba = fixture("interleave-aba.jsonl");
	assert.deepStrictEqual(parseTranscriptFile(aba, freshNow(aba)), {
		records: [],
		deferred: 2,
		malformed: 0,
	});

	const streaming = fixture("streaming-duplicate.jsonl");
	assert.deepStrictEqual(parseTranscriptFile(streaming, freshNow(streaming)), {
		records: [],
		deferred: 1,
		malformed: 0,
	});

	// deferred counts EMITTABLE ids: synthetic + unparseable lines never count.
	const mixed = fixture("synthetic-and-malformed.jsonl");
	assert.deepStrictEqual(parseTranscriptFile(mixed, freshNow(mixed)), {
		records: [],
		deferred: 1,
		malformed: 0,
	});

	// A deferred file reports NO refusals: its lines are still being rewritten,
	// so a counter absent right now may be present in the final line.
	const counters = fixture("missing-counters.jsonl");
	assert.deepStrictEqual(parseTranscriptFile(counters, freshNow(counters)), {
		records: [],
		deferred: 1,
		malformed: 0,
	});
});

test("isQuiescent: exact 30-minute boundary on mtime age", () => {
	assert.equal(QUIESCENCE_MS, 30 * 60 * 1000); // spec-pinned constant
	assert.equal(isQuiescent(0, QUIESCENCE_MS), true);
	assert.equal(isQuiescent(0, QUIESCENCE_MS - 1), false);
	assert.equal(isQuiescent(1_000, 1_000 + QUIESCENCE_MS), true);
	assert.equal(isQuiescent(1_000, 1_000), false);
});

test("ALLOWLIST: every record from every fixture has EXACTLY the FleetRecord keys", () => {
	const names = readdirSync(FIXTURES).filter((n) => n.endsWith(".jsonl"));
	assert.equal(names.length, 8, "fixture inventory drifted");
	let total = 0;
	for (const name of names) {
		const path = fixture(name);
		const { records } = parseTranscriptFile(path, quiescentNow(path));
		assert.ok(records.length >= 1, `${name}: expected at least one record`);
		for (const record of records) {
			total += 1;
			// THE contract: exact keys, nothing else may leave the parser.
			assert.deepStrictEqual(Object.keys(record), FLEET_RECORD_KEYS, name);
			// No nested objects — a nested value could smuggle content past the keys.
			for (const [key, value] of Object.entries(record)) {
				assert.ok(
					["string", "number", "boolean"].includes(typeof value),
					`${name}: ${key} is not a primitive`,
				);
			}
		}
	}
	assert.equal(total, 11); // a:1 b:2 c:1 d:1 e:1 f:1 g:1 h:3
});

test("sessionHash: 12 hex chars, never the raw sessionId, raw id never serialized", () => {
	const names = readdirSync(FIXTURES).filter((n) => n.endsWith(".jsonl"));
	for (const name of names) {
		const path = fixture(name);
		const { records } = parseTranscriptFile(path, quiescentNow(path));
		for (const record of records) {
			assert.match(record.sessionHash, /^[0-9a-f]{12}$/);
			assert.notEqual(record.sessionHash, `fixture-session-${name[0]}`);
		}
		// Every fixture sessionId starts with "fixture-session"; the string must
		// not survive anywhere in the parser's output.
		assert.ok(!JSON.stringify(records).includes("fixture-session"), name);
	}
});

test("missing nested cache_creation defaults {5m: flat, 1h: 0}; absent speed defaults standard", () => {
	const path = fixture("no-nested-cache.jsonl");
	const { records } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(records.length, 1);
	assert.equal(records[0].cacheWrite5m, 640); // flat cache_creation_input_tokens
	assert.equal(records[0].cacheWrite1h, 0);
	assert.equal(records[0].speed, "standard"); // older shape has no usage.speed
	assert.equal(records[0].cacheReadTokens, 2500);
});

test("missing/unusable input or output counter: record REFUSED and counted malformed (D5)", () => {
	// Codex PR-91 #2. Coercing an absent counter to 0 makes the fake client
	// report numeric zeros, so core labels the receipt usageSource "provider"
	// and the rollup prices a real call at the 1-usertoken floor — a fabricated
	// provider-metered zero, exactly the mislabel D5 kills. Unusable means the
	// same three things core's `readCount` means: absent, non-numeric, negative.
	const path = fixture("missing-counters.jsonl");
	const { records, deferred, malformed } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(deferred, 0);
	assert.equal(malformed, 3, "no input / string output / negative input");
	assert.equal(records.length, 1);
	assert.equal(records[0]?.messageId, "msg_fix_g_good");
	assert.equal(records[0]?.inputTokens, 6);
	assert.equal(records[0]?.outputTokens, 7);
});

test("cache-tier fallback matches core's fromAnthropicUsage precedence exactly", () => {
	// Codex PR-91 #3. Presence of the cache_creation OBJECT must not select the
	// nested branch: core falls back to the flat counter whenever NEITHER tier
	// yields a usable number, and recording zero there underprices the call
	// against the very receipt core mints from these numbers. Expected values
	// below are core's, tier-by-tier (5m + 1h == its cacheWriteTokens).
	const path = fixture("cache-tier-fallback.jsonl");
	const { records, malformed } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(malformed, 0);
	const byId = new Map(records.map((r) => [r.messageId, r]));

	// Empty nested block + valid flat 512 ⇒ flat wins, {5m: 512, 1h: 0}.
	assert.equal(byId.get("msg_fix_h_empty")?.cacheWrite5m, 512);
	assert.equal(byId.get("msg_fix_h_empty")?.cacheWrite1h, 0);
	// ONE usable tier ⇒ the nested block wins and the flat 999 is ignored.
	assert.equal(byId.get("msg_fix_h_onetier")?.cacheWrite5m, 0);
	assert.equal(byId.get("msg_fix_h_onetier")?.cacheWrite1h, 7);
	// Both tiers junk (string, null) ⇒ flat 300 wins, not zero.
	assert.equal(byId.get("msg_fix_h_junk")?.cacheWrite5m, 300);
	assert.equal(byId.get("msg_fix_h_junk")?.cacheWrite1h, 0);

	// The claim, stated as core states it: our tier sum IS fromAnthropicUsage's
	// cacheWriteTokens for the same payload. Re-derived here from core's rules
	// rather than imported (usage.ts is not a public export).
	for (const [id, flat, expected] of [
		["msg_fix_h_empty", 512, 512],
		["msg_fix_h_onetier", 999, 7],
		["msg_fix_h_junk", 300, 300],
	] as const) {
		const record = byId.get(id);
		assert.ok(record, `${id} missing`);
		assert.equal(record.cacheWrite5m + record.cacheWrite1h, expected, `${id} (flat ${flat})`);
	}
});

test("malformed line skipped without throwing; <synthetic> model skipped; parsing continues", () => {
	const path = fixture("synthetic-and-malformed.jsonl");
	// The malformed line sits BETWEEN the synthetic and the good line — the good
	// record surviving proves the parser continues past the parse failure.
	const { records, deferred } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(deferred, 0);
	assert.equal(records.length, 1);
	assert.equal(records[0].messageId, "msg_fix_e_good");
	assert.equal(records[0].outputTokens, 13);
	assert.equal(records[0].cacheWrite5m, 100);
	assert.equal(records[0].cacheWrite1h, 20);
});

test('speed "fast" passes the parser (pre-flight rejects it later, not here)', () => {
	const path = fixture("fast-speed.jsonl");
	const { records } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(records.length, 1);
	assert.equal(records[0].speed, "fast");
	assert.equal(records[0].messageId, "msg_fix_f_001");
});

test("sidechain record keeps isSidechain: true", () => {
	const path = fixture("sidechain.jsonl");
	const { records } = parseTranscriptFile(path, quiescentNow(path));
	assert.equal(records.length, 1);
	assert.equal(records[0].isSidechain, true);
	assert.equal(records[0].messageId, "msg_fix_c_001");
});
