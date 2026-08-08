import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("capture-evidence --dry-run-only writes well-formed fixtures (no TigerBeetle needed)", {
	timeout: 120_000,
}, () => {
	const out = mkdtempSync(join(tmpdir(), "evidence-test-"));
	try {
		execFileSync("npx", ["tsx", "scripts/capture-evidence.mts", "--dry-run-only", "--out", out], {
			cwd: REPO_ROOT,
			encoding: "utf-8",
			stdio: "pipe",
		});

		// facts.json — all seventeen fact keys, each with a source string
		const facts = JSON.parse(readFileSync(join(out, "facts.json"), "utf-8"));
		for (const key of [
			"transferCodes",
			"policyOperators",
			"verifierRuntimeDeps",
			"modelCount",
			"license",
			"commandsToFirstReceipt",
			"quickstartMinutes",
			"filmDurationSeconds",
			"usertokensPerFiveDollars",
			"caseFileCalls",
			"caseFileDollars",
			"accountCodes",
			"invariantCount",
			"hardenSuiteCount",
			"testCaseCount",
			"expectAssertionCount",
			"verifierSharedLines",
		]) {
			assert.ok(key in facts.facts, `facts.${key} missing`);
			assert.equal(typeof facts.facts[key].source, "string");
		}
		assert.equal(facts.facts.caseFileCalls.value, 47);
		assert.equal(facts.facts.caseFileDollars.value, 500);
		assert.equal(facts.facts.transferCodes.value, 9);
		assert.equal(facts.facts.policyOperators.value, 12);
		assert.equal(facts.facts.verifierRuntimeDeps.value, 0);
		assert.equal(facts.facts.modelCount.numeric, 20);
		assert.equal(facts.facts.usertokensPerFiveDollars.value, 50000);

		// Addendum D7 — new derived counts. Exact pins only where the value is a
		// sanctioned claim; plausibility floors for counts that move with the suite.
		assert.equal(facts.facts.accountCodes.value, 3); // CODE_USER_WALLET · CODE_PLATFORM_TREASURY · CODE_ESCROW
		assert.equal(facts.facts.verifierSharedLines.value, 0); // parity contract
		assert.ok(facts.facts.invariantCount.value >= 20, "AGENTS.md Prevents: count implausibly low");
		assert.ok(facts.facts.hardenSuiteCount.value >= 40, "harden suite count implausibly low");
		assert.ok(facts.facts.testCaseCount.value >= 2000, "test-case count implausibly low");
		assert.ok(facts.facts.expectAssertionCount.value >= 4000, "expect() count implausibly low");
		assert.ok(facts.facts.expectAssertionCount.value > facts.facts.testCaseCount.value);
		// Addendum D6: expect() totals are TEST assertions, never runtime guarantees.
		assert.match(facts.facts.expectAssertionCount.source, /TEST assertions/);

		// attack-corpus.json — names + pinned verdicts from the REAL corpus test file.
		// 29 it() cases cover spec rows 1-30 (row 17 is folded into case 5).
		const corpus = JSON.parse(readFileSync(join(out, "attack-corpus.json"), "utf-8"));
		assert.equal(corpus.attacks.length, 29);
		const verdicts = new Set([
			"UNANCHORED",
			"ANCHORED_VERIFIED",
			"ANCHOR_STALE",
			"ANCHOR_UNVERIFIABLE",
			"ANCHOR_INVALID",
			"ANCHOR_MISMATCH",
		]);
		for (const attack of corpus.attacks) {
			assert.ok(typeof attack.name === "string" && attack.name.length > 0, "empty attack name");
			assert.ok(verdicts.has(attack.verdict), `unknown verdict: ${attack.verdict}`);
		}
		assert.equal(new Set(corpus.attacks.map((a) => a.name)).size, corpus.attacks.length);
		assert.match(corpus.attacks[0].name, /^1\. F1 KILL/);
		assert.equal(corpus.attacks[0].verdict, "ANCHOR_MISMATCH");

		// dry-run receipt — locally-minted tx_ id, honest mode label
		const dry = JSON.parse(readFileSync(join(out, "receipt-dryrun.json"), "utf-8"));
		assert.match(dry.receipt.transferId, /^tx_/);
		assert.equal(dry.provenance.mode, "dry-run");
		assert.equal(dry.provenance.tigerbeetleVersion, null);
		assert.equal(typeof dry.receipt.cost.estimated, "number");
		assert.equal(dry.receipt.settled, true);

		// chain slice — exactly 8 entries, internally linked
		const slice = JSON.parse(readFileSync(join(out, "chain-slice.json"), "utf-8"));
		assert.equal(slice.entries.length, 8);
		for (let i = 1; i < slice.entries.length; i++) {
			assert.equal(
				slice.entries[i].prevHash,
				slice.entries[i - 1].hash,
				`chain broken at slice index ${i}`,
			);
		}

		// verifier transcript — real workspace verifier, exit 0
		const transcript = JSON.parse(readFileSync(join(out, "verify-transcript.json"), "utf-8"));
		assert.equal(transcript.exitCode, 0);
		assert.equal(transcript.command, "npx usertrust-verify .usertrust");
		assert.ok(Array.isArray(transcript.lines) && transcript.lines.length > 0);

		// raw chain copy present; ledger fixture must NOT exist in dry-run-only mode
		assert.ok(existsSync(join(out, "chain.jsonl")));
		assert.ok(
			!existsSync(join(out, "receipt-ledger.json")),
			"ledger fixture must not be written by --dry-run-only",
		);
	} finally {
		rmSync(out, { recursive: true, force: true });
	}
});
