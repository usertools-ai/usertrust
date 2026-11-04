// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — `anchor doctor`, the S3 sink flags, and `anchor export-bundle`
 * (plan T6 + deltas D9/D10).
 *
 * These properties are worth more than the surface area they sit on:
 *
 *   1. An option an action does not read is refused (exit 2), never ignored: a
 *      dropped sink flag would run the action with fewer sinks than asked for.
 *   2. A sink flag whose value is missing is fatal. The mirror-image failure of
 *      (1): `anchor now --sink-s3` parsing to zero sinks means the anchor is
 *      signed, mirrored locally, published NOWHERE, and reported as success.
 *   3. `export-bundle` is all-or-nothing on stdout. A bundle is what an auditor
 *      receives INSTEAD of the vault, so a partial one is worse than no bundle
 *      at all. Any error means diagnostics on stderr, exit 1, and not one byte
 *      on stdout (D9).
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
}

/** A vault with two anchors in its local mirror. */
async function twoAnchorVault(): Promise<{ s: AnchoredSetup; records: AnchorRecord[] }> {
	const s = await makeAnchoredVault(3);
	const first = await anchorOnce(s);
	await appendEvents(s.root, 2, 4);
	const second = await anchorOnce(s);
	return { s, records: [first, second] };
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

	it("3. url sinks report info rows instead of a probe", async () => {
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

describe("HARDEN: sink flag parsing (--sink-s3)", () => {
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

	it("7. a sink flag that was removed is refused as an unknown option (exit 2)", async () => {
		for (const flag of ["--sink-rekor", "--sink-rekor=https://log.internal:8443"]) {
			for (const action of ["now", "doctor"]) {
				const o = await cli([action, flag], true);

				const parsed = JSON.parse(o.out.at(-1) as string);
				expect(parsed.success).toBe(false);
				expect(parsed.data.message).toMatch(/has no option/);
				expect(parsed.data.message).toContain(flag);
				expect(process.exitCode).toBe(2);
			}
		}
	});

	it("8. a removed flag is refused even beside valid sink flags", async () => {
		const dir = tmp("unknown-flag-");
		const sink = join(dir, "anchors.jsonl");
		writeFileSync(sink, "");

		const o = await cli(["doctor", "--sink-rekor", "--sink-file", sink], true);

		expect(JSON.parse(o.out.at(-1) as string).data.message).toMatch(/has no option/);
		expect(process.exitCode).toBe(2);
	});
});

describe("HARDEN: `anchor export-bundle`", () => {
	it("10. bundles the mirror records, and nothing else", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const o = await cli(["export-bundle"]);

		expect(o.out).toHaveLength(1);
		const bundle = JSON.parse(o.out[0] as string) as Bundle;
		expect(Object.keys(bundle).sort()).toEqual(["records", "v"]);
		expect(bundle.v).toBe(1);
		expect(bundle.records.map((r) => r.anchorSeq)).toEqual([1, 2]);
		expect(process.exitCode).toBe(0);
	});

	it("11. the exported bundle verifies the vault it came from (round trip)", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const bundle = JSON.parse((await cli(["export-bundle"])).out[0] as string) as Bundle;
		process.chdir(origCwd);

		const result = verifyVaultWithAnchors(s.vaultPath, {
			externalAnchorsRaw: [bundle.records.map((r) => JSON.stringify(r)).join("\n")],
			trust: s.trust,
			witness: { requested: false },
		});

		expect(result.anchorState).toBe("ANCHORED_VERIFIED");
	});

	it("12. --since drops everything already shipped, and an empty bundle is still valid", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const since1 = JSON.parse(
			(await cli(["export-bundle", "--since", "1"])).out[0] as string,
		) as Bundle;
		expect(since1.records.map((r) => r.anchorSeq)).toEqual([2]);

		const since2 = JSON.parse(
			(await cli(["export-bundle", "--since", "2"])).out[0] as string,
		) as Bundle;
		expect(since2.records).toEqual([]);
		expect(process.exitCode).toBe(0);
	});

	it("13. --since must be a non-negative integer", async () => {
		const { s } = await twoAnchorVault();
		process.chdir(s.root);

		const o = await cli(["export-bundle", "--since", "1O"]);

		expect(o.out).toEqual([]);
		expect(o.err.join("\n")).toMatch(/--since/);
		expect(process.exitCode).toBe(1);
	});

	it("14. a vault with no mirror exports nothing at all", async () => {
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
	it("15. lists the actions and sink flags", async () => {
		const o = await cli([]);

		const usage = o.out.join("\n");
		expect(usage).toMatch(/export-bundle/);
		expect(usage).toMatch(/doctor/);
		expect(usage).toMatch(/--sink-s3/);
		expect(usage).not.toMatch(/rekor/i);
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
