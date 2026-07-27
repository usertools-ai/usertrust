// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — `anchor doctor`, the S3/Rekor sink flags, and `anchor export-bundle`
 * (plan T6 + deltas D8/D9/D10).
 *
 * Two properties are worth more than the surface area they sit on:
 *
 *   1. `--sink-rekor` NEVER consumes the token after it. A flag that swallows
 *      the next argv entry turns `--sink-rekor --sink-file /mnt/worm/a.jsonl`
 *      into a run with NO file sink, and the operator would only find out at
 *      audit time (D8).
 *   2. `export-bundle` is all-or-nothing on stdout. A bundle is what an auditor
 *      receives INSTEAD of the vault, so a partial one — records present,
 *      receipts silently dropped because a file failed to parse — is worse than
 *      no bundle at all. Any parse error means diagnostics on stderr, exit 1,
 *      and not one byte on stdout (D9).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { anchorsDir } from "../../../src/audit/anchor.js";
import type { AnchorRecord } from "../../../src/audit/anchor-verify.js";
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
	rekorReceipts: unknown[];
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
