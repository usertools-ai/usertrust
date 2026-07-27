// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * HARDEN — `anchor doctor` store probes (spec §12, plan T4 + delta D10).
 *
 * The doctor is a PERMISSION PROBE, never a proof of immutability: it writes a
 * throwaway probe object and reports whether THIS identity could delete or
 * overwrite it RIGHT NOW. These tests pin that semantic — the verdicts, the
 * copy that carries them, and the D6 rule that a probe error never echoes the
 * `authorization` or `x-amz-security-token` headers.
 */

import { chmodSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DoctorReport,
	doctorFileSink,
	doctorS3Sink,
	type HttpTransport,
} from "../../../src/audit/anchor-doctor.js";
import { hashPayload } from "../../../src/audit/sigv4.js";
import { cleanupAll, tmp } from "./fixtures.js";

afterEach(() => {
	vi.unstubAllEnvs();
	cleanupAll();
});

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

function check(report: DoctorReport, name: string): { status: string; detail: string } {
	const found = report.checks.find((c) => c.name === name);
	if (found === undefined) {
		throw new Error(`no "${name}" check in: ${report.checks.map((c) => c.name).join(", ")}`);
	}
	return found;
}

const copy = (report: DoctorReport): string => report.checks.map((c) => c.detail).join("\n");

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}

interface Scripted {
	status?: number;
	body?: string;
	headers?: Record<string, string>;
	throws?: Error;
}

/** Transport that replays `responses` in order and records what it was asked to send. */
function scriptedTransport(responses: Scripted[]): { transport: HttpTransport; calls: Call[] } {
	const calls: Call[] = [];
	let next = 0;
	const transport: HttpTransport = async (opts) => {
		calls.push({ method: opts.method, url: opts.url, headers: opts.headers, body: opts.body });
		const scripted = responses[next++];
		if (scripted === undefined) {
			throw new Error(`unscripted request #${next}: ${opts.method} ${opts.url}`);
		}
		if (scripted.throws !== undefined) throw scripted.throws;
		return {
			status: scripted.status ?? 200,
			body: scripted.body ?? "",
			...(scripted.headers === undefined ? {} : { headers: scripted.headers }),
		};
	};
	return { transport, calls };
}

const S3_CFG = { bucket: "b", region: "us-east-1" };

function stubCreds(sessionToken?: string): void {
	vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
	vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
	vi.stubEnv("AWS_SESSION_TOKEN", sessionToken);
}

// ── File sink ──

describe("doctorFileSink", () => {
	it("fails both probes in an ordinary writable store directory", () => {
		const dir = tmp("doctor-file-");
		const sinkPath = join(dir, "anchors.jsonl");
		writeFileSync(sinkPath, "");

		const report = doctorFileSink(sinkPath);

		expect(check(report, "delete-denied").status).toBe("fail");
		expect(check(report, "overwrite-denied").status).toBe("fail");
		expect(report.failed).toBe(true);
	});

	it("removes the probe object it created", () => {
		const dir = tmp("doctor-file-clean-");
		const sinkPath = join(dir, "anchors.jsonl");
		writeFileSync(sinkPath, "");

		doctorFileSink(sinkPath);

		expect(readdirSync(dir).filter((f) => f.startsWith(".doctor-probe"))).toEqual([]);
		expect(existsSync(sinkPath)).toBe(true);
	});

	it("worded as a permission probe — never as proof that the store is append-only", () => {
		const dir = tmp("doctor-file-copy-");
		const sinkPath = join(dir, "anchors.jsonl");
		writeFileSync(sinkPath, "");

		const text = copy(doctorFileSink(sinkPath));

		expect(text).toMatch(/this identity could delete a probe object at .+ right now/);
		expect(text).toMatch(/this identity could overwrite a probe object at .+ right now/);
		expect(text).not.toMatch(/append-only|immutab|write-once|WORM/i);
		expect(text).not.toMatch(/proven|guarantee/i);
	});

	it.skipIf(isRoot)("reports info, not pass, when it cannot create a probe object", () => {
		const dir = tmp("doctor-file-ro-");
		const sinkPath = join(dir, "anchors.jsonl");
		writeFileSync(sinkPath, "");
		chmodSync(dir, 0o555);
		try {
			const report = doctorFileSink(sinkPath);

			expect(report.checks).toHaveLength(1);
			expect(check(report, "probe").status).toBe("info");
			expect(check(report, "probe").detail).toMatch(/cannot probe/);
			// The absence of a delete verdict must not read as a passing one.
			expect(report.checks.some((c) => c.status === "pass")).toBe(false);
			expect(report.failed).toBe(false);
		} finally {
			chmodSync(dir, 0o700);
		}
	});

	it("names the sink it probed", () => {
		const dir = tmp("doctor-file-name-");
		const sinkPath = join(dir, "anchors.jsonl");
		writeFileSync(sinkPath, "");

		expect(doctorFileSink(sinkPath).sink).toBe(`file:${sinkPath}`);
	});
});

// ── S3 sink ──

describe("doctorS3Sink", () => {
	it("passes both probes when the store denies delete and overwrite", async () => {
		stubCreds();
		const { transport } = scriptedTransport([
			{ status: 200 },
			{ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" },
			{ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" },
		]);

		const report = await doctorS3Sink(S3_CFG, transport);

		expect(check(report, "delete-denied").status).toBe("pass");
		expect(check(report, "overwrite-denied").status).toBe("pass");
		expect(report.failed).toBe(false);
		expect(copy(report)).toMatch(/could not delete a probe object at .+ right now/);
		expect(copy(report)).toMatch(/could not overwrite a probe object at .+ right now/);
	});

	it("signs a PUT / DELETE / PUT cycle against one probe key", async () => {
		stubCreds();
		const { transport, calls } = scriptedTransport([
			{ status: 200 },
			{ status: 403 },
			{ status: 403 },
		]);

		await doctorS3Sink(S3_CFG, transport);

		expect(calls.map((c) => c.method)).toEqual(["PUT", "DELETE", "PUT"]);
		const urls = new Set(calls.map((c) => c.url));
		expect(urls.size).toBe(1);
		expect(calls[0]?.url).toMatch(
			/^https:\/\/b\.s3\.us-east-1\.amazonaws\.com\/anchors\/doctor-probe\/\d+-\d{8}T\d{6}Z\.json$/,
		);
		for (const call of calls) {
			expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
			expect(call.headers["x-amz-content-sha256"]).toBe(hashPayload(call.body));
			expect(call.headers["x-amz-security-token"]).toBeUndefined();
		}
		// A probe writes a throwaway object, never store data.
		expect(calls[0]?.body.length).toBeGreaterThan(0);
		expect(calls[1]?.body.length).toBe(0);
	});

	it("carries a session token into the signed request when one is in the environment", async () => {
		stubCreds("SESSIONTOKENSECRET");
		const { transport, calls } = scriptedTransport([
			{ status: 200 },
			{ status: 403 },
			{ status: 403 },
		]);

		await doctorS3Sink(S3_CFG, transport);

		expect(calls[0]?.headers["x-amz-security-token"]).toBe("SESSIONTOKENSECRET");
	});

	it("fails when the store lets this identity delete and overwrite the probe", async () => {
		stubCreds();
		const { transport } = scriptedTransport([{ status: 200 }, { status: 204 }, { status: 200 }]);

		const report = await doctorS3Sink(S3_CFG, transport);

		expect(check(report, "delete-denied").status).toBe("fail");
		expect(check(report, "overwrite-denied").status).toBe("fail");
		expect(report.failed).toBe(true);
		expect(copy(report)).toMatch(/could delete a probe object at .+ right now/);
	});

	it("reports info, not fail, when an overwrite lands as a new version", async () => {
		stubCreds();
		const versioned = { "x-amz-version-id": "3sL4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY" };
		const { transport } = scriptedTransport([
			{ status: 200, headers: versioned },
			{ status: 403 },
			{ status: 200, headers: versioned },
		]);

		const report = await doctorS3Sink(S3_CFG, transport);

		expect(check(report, "delete-denied").status).toBe("pass");
		expect(check(report, "overwrite-denied").status).toBe("info");
		expect(check(report, "overwrite-denied").detail).toMatch(/version/i);
		expect(check(report, "overwrite-denied").detail).toMatch(/Object Lock/);
		expect(report.failed).toBe(false);
	});

	it("uses a path-style URL against a configured endpoint", async () => {
		stubCreds();
		const { transport, calls } = scriptedTransport([
			{ status: 200 },
			{ status: 403 },
			{ status: 403 },
		]);

		await doctorS3Sink(
			{ ...S3_CFG, prefix: "vault-anchors", endpoint: "https://s3.example" },
			transport,
		);

		expect(calls[0]?.url).toMatch(
			/^https:\/\/s3\.example\/b\/vault-anchors\/doctor-probe\/\d+-\d{8}T\d{6}Z\.json$/,
		);
	});

	it("reports info and stops when the probe object cannot be written at all", async () => {
		stubCreds();
		const { transport, calls } = scriptedTransport([
			{ status: 403, body: "<Error><Code>AccessDenied</Code></Error>" },
		]);

		const report = await doctorS3Sink(S3_CFG, transport);

		expect(calls).toHaveLength(1);
		expect(report.checks).toHaveLength(1);
		expect(check(report, "probe").status).toBe("info");
		expect(check(report, "probe").detail).toMatch(/cannot probe/);
		expect(report.failed).toBe(false);
	});

	it("reports info without touching the network when credentials are absent", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", undefined);
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", undefined);
		const { transport, calls } = scriptedTransport([]);

		const report = await doctorS3Sink(S3_CFG, transport);

		expect(calls).toHaveLength(0);
		expect(check(report, "probe").status).toBe("info");
		expect(check(report, "probe").detail).toMatch(/AWS_ACCESS_KEY_ID/);
		expect(report.failed).toBe(false);
	});

	it("never echoes the authorization or session-token headers into a probe error", async () => {
		stubCreds("SESSIONTOKENSECRET");
		const leak = new Error(
			"socket hang up while sending headers: authorization=AWS4-HMAC-SHA256 " +
				"Credential=AKIDEXAMPLE/20260727/us-east-1/s3/aws4_request, Signature=deadbeef; " +
				"x-amz-security-token=SESSIONTOKENSECRET",
		);
		const { transport } = scriptedTransport([{ throws: leak }]);

		const report = await doctorS3Sink(S3_CFG, transport);

		const text = copy(report);
		expect(text).not.toMatch(/AKIDEXAMPLE/);
		expect(text).not.toMatch(/SESSIONTOKENSECRET/);
		expect(text).not.toMatch(/AWS4-HMAC-SHA256/);
		expect(text).not.toMatch(/Signature=/);
		expect(check(report, "probe").status).toBe("info");
	});
});
