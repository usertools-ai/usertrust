// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — `anchor doctor`, the S3/Rekor sink flags, and `anchor export-bundle`
 * (plan T6 + deltas D8/D9/D10).
 *
 * These properties are worth more than the surface area they sit on:
 *
 *   1. `--sink-rekor` NEVER consumes the token after it. A flag that swallows
 *      the next argv entry turns `--sink-rekor --sink-file /mnt/worm/a.jsonl`
 *      into a run with NO file sink, and the operator would only find out at
 *      audit time (D8).
 *   2. A sink flag whose value is missing is fatal. The mirror-image failure of
 *      (1): `anchor now --sink-s3` parsing to zero sinks means the anchor is
 *      signed, mirrored locally, published NOWHERE, and reported as success.
 *   3. `export-bundle` is all-or-nothing on stdout. A bundle is what an auditor
 *      receives INSTEAD of the vault, so a partial one — records present,
 *      receipts silently dropped because a file failed to parse — is worse than
 *      no bundle at all. Any parse error means diagnostics on stderr, exit 1,
 *      and not one byte on stdout (D9).
 *   4. …with exactly one exception, which is not a parse failure: receipts
 *      orphaned by `anchor resume` are excluded with a warning, because
 *      including them would make the verifier reject the whole bundle.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorsDir } from "../../../src/audit/anchor.js";
import type { AnchorRecord } from "../../../src/audit/anchor-verify.js";
import type { RekorReceipt } from "../../../src/audit/rekor-verify.js";
import { verifyVaultWithAnchors } from "../../../src/audit/verify.js";
import { run as anchorRun } from "../../../src/cli/anchor.js";
import {
	type AnchoredSetup,
	anchorOnce,
	appendEvents,
	cleanupAll,
	makeAnchoredVault,
	tmp,
} from "./fixtures.js";
import { makeRekorReceipt } from "./rekor-fixtures.js";

const origCwd = process.cwd();

afterEach(() => {
	process.chdir(origCwd);
	process.exitCode = 0;
	vi.restoreAllMocks();
	cleanupAll();
});

interface CliOutput {
	out: string[];
	err: string[];
}

/** Run the CLI in-process with stdout and stderr captured separately. */
async function cli(args: string[], json = false): Promise<CliOutput> {
	const out: string[] = [];
	const err: string[] = [];
	const logSpy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
		out.push(a.map(String).join(" "));
	});
	const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		err.push(a.map(String).join(" "));
	});
	try {
		await anchorRun(args, { json });
	} finally {
		logSpy.mockRestore();
		errSpy.mockRestore();
	}
	return { out, err };
}

interface DoctorJson {
	success: boolean;
	data: {
		failed: boolean;
		reports: { sink: string; failed: boolean; checks: { name: string; status: string }[] }[];
	};
}

const doctorJson = (o: CliOutput): DoctorJson => JSON.parse(o.out.at(-1) as string) as DoctorJson;

interface Bundle {
	v: number;
	records: AnchorRecord[];
	rekorReceipts: RekorReceipt[];
}

/** A vault with two anchors in its local mirror. */
async function twoAnchorVault(): Promise<{ s: AnchoredSetup; records: AnchorRecord[] }> {
	const s = await makeAnchoredVault(3);
	const first = await anchorOnce(s);
	await appendEvents(s.root, 2, 4);
	const second = await anchorOnce(s);
	return { s, records: [first, second] };
}

/** Place a receipt where the Rekor sink writes them: audit/anchors/rekor/<seq12>.json */
function placeReceipt(root: string, anchorSeq: number, body: string): void {
	const dir = join(anchorsDir(root), "rekor");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${String(anchorSeq).padStart(12, "0")}.json`), body);
}

describe("HARDEN: `anchor doctor` reports what this identity can do to the store", () => {
	it("1. a deletable file-sink directory fails the probe (exit 1, failed:true)", async () => {
		const dir = tmp("doctor-cli-");
		const sink = join(dir, "anchors.jsonl");
		writeFileSync(sink, "");

		const o = await cli(["doctor", "--sink-file", sink], true);

		const parsed = doctorJson(o);
		expect(parsed.success).toBe(false);
		expect(parsed.data.failed).toBe(true);
		expect(parsed.data.reports).toHaveLength(1);
		expect(parsed.data.reports[0]?.sink).toBe(`file:${sink}`);
		expect(parsed.data.reports[0]?.failed).toBe(true);
		expect(process.exitCode).toBe(1);
	});

	it("2. human output carries the permission-probe wording, never a proof claim", async () => {
		const dir = tmp("doctor-copy-");
		const sink = join(dir, "anchors.jsonl");
		writeFileSync(sink, "");

		const o = await cli(["doctor", "--sink-file", sink]);

		const text = o.out.join("\n");
		expect(text).toMatch(/could delete a probe object at .* right now/);
		expect(text).not.toMatch(/append-only.{0,40}(proven|verified|guaranteed)/i);
		expect(process.exitCode).toBe(1);
	});

	it("3. url and transparency-log sinks report info rows instead of a probe", async () => {
		const o = await cli(["doctor", "--sink-url", "https://ingest.example/anchors"], true);

		const parsed = doctorJson(o);
		expect(parsed.success).toBe(true);
		expect(parsed.data.failed).toBe(false);
		expect(parsed.data.reports[0]?.sink).toBe("https:https://ingest.example/anchors");
		expect(parsed.data.reports[0]?.checks[0]?.status).toBe("info");
		expect(process.exitCode).toBe(0);
	});

	it("4. probing nothing is an error, not a silent pass", async () => {
		const o = await cli(["doctor"], true);

		expect(JSON.parse(o.out.at(-1) as string).success).toBe(false);
		expect(o.out.join("\n")).toMatch(/no sink configured/);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: sink flag parsing (--sink-s3, --sink-rekor)", () => {
	it("5. --sink-s3 without a region fails loudly instead of guessing one", async () => {
		const o = await cli(["doctor", "--sink-s3", "bucket=b"], true);

		const parsed = JSON.parse(o.out.at(-1) as string);
		expect(parsed.success).toBe(false);
		expect(parsed.data.message).toMatch(/--sink-s3/);
		expect(parsed.data.message).toMatch(/region/);
		expect(process.exitCode).toBe(1);
	});

	it("6. --sink-s3 rejects unknown keys", async () => {
		const o = await cli(["doctor", "--sink-s3", "bucket=b,region=us-east-1,bukcet=typo"], true);

		expect(JSON.parse(o.out.at(-1) as string).data.message).toMatch(/bukcet/);
		expect(process.exitCode).toBe(1);
	});

	it("7. bare --sink-rekor takes the default log and does NOT eat the next token", async () => {
		const dir = tmp("rekor-flag-");
		const sink = join(dir, "anchors.jsonl");
		writeFileSync(sink, "");

		const o = await cli(["doctor", "--sink-rekor", "--sink-file", sink], true);

		const reports = doctorJson(o).data.reports;
		expect(reports.map((r) => r.sink)).toEqual([
			"rekor:https://rekor.sigstore.dev",
			`file:${sink}`,
		]);
	});

	it("8. --sink-rekor=<url> pins a custom log", async () => {
		const o = await cli(["doctor", "--sink-rekor=https://log.internal:8443"], true);

		expect(doctorJson(o).data.reports[0]?.sink).toBe("rekor:https://log.internal:8443");
		expect(process.exitCode).toBe(0);
	});

	it("9. the space-separated form is refused rather than silently routed to the default", async () => {
		const o = await cli(["doctor", "--sink-rekor", "https://log.internal"], true);

		expect(JSON.parse(o.out.at(-1) as string).data.message).toMatch(/--sink-rekor=<url>/);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: `anchor export-bundle`", () => {
	it("10. bundles the mirror records together with the receipts on disk", async () => {
		const { s, records } = await twoAnchorVault();
		const f = makeRekorReceipt(records[1] as AnchorRecord);
		placeReceipt(s.root, 2, JSON.stringify(f.receipt));
		process.chdir(s.root);

		const o = await cli(["export-bundle"]);

		expect(o.out).toHaveLength(1);
		const bundle = JSON.parse(o.out[0] as string) as Bundle;
		expect(bundle.v).toBe(1);
		expect(bundle.records).toHaveLength(2);
		expect(bundle.records.map((r) => r.anchorSeq)).toEqual([1, 2]);
		expect(bundle.rekorReceipts).toHaveLength(1);
		expect(process.exitCode).toBe(0);
	});

	it("11. the exported bundle verifies the vault it came from (round trip)", async () => {
		const { s, records } = await twoAnchorVault();
		const f = makeRekorReceipt(records[1] as AnchorRecord);
		placeReceipt(s.root, 2, JSON.stringify(f.receipt));
		process.chdir(s.root);

		const bundle = JSON.parse((await cli(["export-bundle"])).out[0] as string) as Bundle;
		process.chdir(origCwd);

		const result = verifyVaultWithAnchors(s.vaultPath, {
			externalAnchorsRaw: [bundle.records.map((r) => JSON.stringify(r)).join("\n")],
			rekorReceiptsRaw: bundle.rekorReceipts.map((r) => JSON.stringify(r)),
			rekorLogPubkeysPem: [f.logPubkeyPem],
			trust: s.trust,
			witness: { requested: false },
		});

		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
		expect(result.anchoring.rekor?.receiptsVerified).toBe(1);
		expect(result.anchoring.rekor?.receiptsFailed).toBe(0);
	});

	it("12. --since drops everything already shipped, and an empty bundle is still valid", async () => {
		const { s, records } = await twoAnchorVault();
		placeReceipt(s.root, 2, JSON.stringify(makeRekorReceipt(records[1] as AnchorRecord).receipt));
		process.chdir(s.root);

		const since1 = JSON.parse(
			(await cli(["export-bundle", "--since", "1"])).out[0] as string,
		) as Bundle;
		expect(since1.records.map((r) => r.anchorSeq)).toEqual([2]);
		expect(since1.rekorReceipts).toHaveLength(1);

		const since2 = JSON.parse(
			(await cli(["export-bundle", "--since", "2"])).out[0] as string,
		) as Bundle;
		expect(since2.records).toEqual([]);
		expect(since2.rekorReceipts).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	it("13. a corrupt receipt file fails the export closed — stderr, exit 1, NO stdout", async () => {
		const { s, records } = await twoAnchorVault();
		placeReceipt(s.root, 1, JSON.stringify(makeRekorReceipt(records[0] as AnchorRecord).receipt));
		placeReceipt(s.root, 2, "{ this is not a receipt");
		process.chdir(s.root);

		const o = await cli(["export-bundle"]);

		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/000000000002\.json/);
		expect(process.exitCode).toBe(1);
	});

	it("14. a receipt that parses but is structurally invalid also fails closed", async () => {
		const { s } = await twoAnchorVault();
		placeReceipt(s.root, 2, JSON.stringify({ v: 1, vaultId: "x", anchorSeq: 2 }));
		process.chdir(s.root);

		const o = await cli(["export-bundle"], true);

		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/rekor-receipt-invalid/);
		expect(process.exitCode).toBe(1);
	});

	it("15. --since must be a non-negative integer", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const o = await cli(["export-bundle", "--since", "1O"]);

		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/--since/);
		expect(process.exitCode).toBe(1);
	});

	it("16. a vault with no mirror exports nothing at all", async () => {
		const root = tmp("bundle-empty-");
		await appendEvents(root, 2);
		process.chdir(root);

		const o = await cli(["export-bundle"]);

		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/mirror/);
		expect(process.exitCode).toBe(1);
	});
});

describe("HARDEN: usage text", () => {
	it("17. lists the new actions and sink flags", async () => {
		const o = await cli([]);

		const usage = o.out.join("\n");
		expect(usage).toMatch(/export-bundle/);
		expect(usage).toMatch(/doctor/);
		expect(usage).toMatch(/--sink-s3/);
		expect(usage).toMatch(/--sink-rekor/);
	});
});

describe("HARDEN: a sink flag with no value never degrades into publishing nowhere", () => {
	// `anchor now --sink-s3` used to parse to ZERO sinks: the record was signed
	// and mirrored locally, nothing was published, and the exit code said 0. The
	// operator finds out at audit time, which is the worst possible moment.
	const flags = ["--sink-file", "--sink-url", "--sink-s3"] as const;
	flags.forEach((flag, i) => {
		it(`${18 + i}. \`anchor now ${flag}\` with a missing value exits 1`, async () => {
			const o = await cli(["now", flag], true);

			const parsed = JSON.parse(o.out.at(-1) as string);
			expect(parsed.success).toBe(false);
			expect(parsed.data.message).toBe(`${flag} requires a value`);
			expect(process.exitCode).toBe(1);
		});
	});
});

describe("HARDEN: `anchor export` --since", () => {
	it("21. a non-numeric --since is refused, not silently read as NaN", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const o = await cli(["export", "--since", "abc"]);

		// NaN made every `anchorSeq > since` false, so the command printed no
		// records and exited 0 — indistinguishable from "nothing left to ship".
		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/--since/);
		expect(process.exitCode).toBe(1);
	});

	it("22. a valid --since still filters normally", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const o = await cli(["export", "--since", "1"]);

		expect(o.out.map((line) => (JSON.parse(line) as AnchorRecord).anchorSeq)).toEqual([2]);
		expect(process.exitCode).toBe(0);
	});
});

describe("HARDEN: export-bundle never ships a receipt the verifier would reject", () => {
	it("23. a receipt with no record in the mirror is excluded with a stderr warning", async () => {
		const { s, records } = await twoAnchorVault();
		placeReceipt(s.root, 1, JSON.stringify(makeRekorReceipt(records[0] as AnchorRecord).receipt));
		placeReceipt(s.root, 2, JSON.stringify(makeRekorReceipt(records[1] as AnchorRecord).receipt));
		// The shape `anchor resume` leaves behind: receipts on disk for anchors
		// whose records are no longer in the re-seeded mirror. Bundling one makes
		// the verifier hard-fail with "receipt for unknown anchorSeq".
		const orphan: RekorReceipt = {
			...makeRekorReceipt(records[1] as AnchorRecord).receipt,
			anchorSeq: 3,
		};
		placeReceipt(s.root, 3, JSON.stringify(orphan));
		process.chdir(s.root);

		const o = await cli(["export-bundle"]);

		const bundle = JSON.parse(o.out[0] as string) as Bundle;
		expect(bundle.records.map((r) => r.anchorSeq)).toEqual([1, 2]);
		expect(bundle.rekorReceipts.map((r) => r.anchorSeq)).toEqual([1, 2]);
		expect(o.err.join("\n")).toContain(
			"export-bundle: excluding receipt for anchorSeq 3 (no matching record in mirror — " +
				"re-fetch the full history to include it)",
		);
		// Expected after a resume, so it is a warning and not a failure (D9's
		// fail-closed rule covers PARSE errors, which this is not).
		expect(process.exitCode).toBe(0);
	});

	it("24. receipts are keyed by the anchorSeq inside them, not by their filename", async () => {
		const { s, records } = await twoAnchorVault();
		const dir = join(anchorsDir(s.root), "rekor");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "000000000002.a1b2c3d4.json"),
			JSON.stringify(makeRekorReceipt(records[1] as AnchorRecord).receipt),
		);
		process.chdir(s.root);

		const o = await cli(["export-bundle"]);

		const bundle = JSON.parse(o.out[0] as string) as Bundle;
		expect(bundle.rekorReceipts.map((r) => r.anchorSeq)).toEqual([2]);
		expect(o.err).toEqual([]);
		expect(process.exitCode).toBe(0);
	});
});
