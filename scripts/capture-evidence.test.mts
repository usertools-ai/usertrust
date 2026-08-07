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

		// facts.json — all eleven fact keys, each with a source string
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
