// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Coverage for the default network transport in rekor.ts (the module's only
 * impure escape hatch — exercised against a local node:http server via the
 * documented localhost-http dev allowance) and the inconclusive/unprobeable
 * verdict branches of the s3 doctor.
 */

import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { doctorS3Sink } from "../../../src/audit/anchor-doctor.js";
import { rekorSink, s3Sink } from "../../../src/audit/rekor.js";
import { anchorOnce, cleanupAll, makeAnchoredVault } from "./fixtures.js";

let server: Server | null = null;

afterEach(async () => {
	vi.unstubAllEnvs();
	if (server !== null) {
		await new Promise<void>((resolve) => server?.close(() => resolve()));
		server = null;
	}
	cleanupAll();
});

function startServer(handler: Parameters<typeof createServer>[1]): Promise<number> {
	server = createServer(handler);
	return new Promise((resolve) => {
		server?.listen(0, "127.0.0.1", () => {
			const addr = server?.address();
			resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
		});
	});
}

describe("default transport (localhost http dev allowance)", () => {
	it("s3 sink publishes through the real transport to a local endpoint", async () => {
		const s = await makeAnchoredVault(2);
		const record = await anchorOnce(s);
		const seen: { method?: string; url?: string; auth?: string } = {};
		const port = await startServer((req, res) => {
			seen.method = req.method ?? "";
			seen.url = req.url ?? "";
			seen.auth = String(req.headers.authorization ?? "");
			req.resume();
			req.on("end", () => {
				res.writeHead(200);
				res.end();
			});
		});
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY");
		const sink = s3Sink({
			bucket: "probe-bucket",
			region: "us-east-1",
			endpoint: `http://127.0.0.1:${port}`,
		});
		await sink.publish(record);
		expect(seen.method).toBe("PUT");
		expect(seen.url).toContain("/probe-bucket/");
		expect(seen.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
	});

	it("rekor sink surfaces a non-201 through the real transport without leaking headers", async () => {
		const s = await makeAnchoredVault(2);
		const record = await anchorOnce(s);
		const port = await startServer((req, res) => {
			req.resume();
			req.on("end", () => {
				res.writeHead(500);
				res.end("upstream exploded");
			});
		});
		const sink = rekorSink(s.root, `http://127.0.0.1:${port}`);
		await expect(sink.publish(record)).rejects.toThrow(/rekor sink: HTTP 500/);
		try {
			await sink.publish(record);
		} catch (err) {
			expect(String(err)).not.toMatch(/authorization|x-amz-security-token/i);
		}
	});
});

describe("s3 doctor verdict branches", () => {
	it("non-403 non-2xx mutation responses report inconclusive, transport errors report unprobeable", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIDEXAMPLE");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secret");
		const scripted = (answers: (number | Error)[]): Parameters<typeof doctorS3Sink>[1] => {
			let i = 0;
			return async () => {
				const a = answers[i++];
				if (a instanceof Error) throw a;
				return { status: a as number, body: "", headers: {} };
			};
		};
		// PUT ok, DELETE 500 (inconclusive), overwrite PUT 403 (denied).
		const inconclusive = await doctorS3Sink(
			{ bucket: "b", region: "us-east-1" },
			scripted([200, 500, 403]),
		);
		expect(inconclusive.failed).toBe(false);
		expect(
			inconclusive.checks.some((c) => c.status === "info" && /inconclusive/.test(c.detail)),
		).toBe(true);
		// Probe PUT itself fails at the transport → cannot probe at all.
		const unprobeable = await doctorS3Sink(
			{ bucket: "b", region: "us-east-1" },
			scripted([new Error("ECONNREFUSED")]),
		);
		expect(unprobeable.failed).toBe(false);
		expect(unprobeable.checks.every((c) => c.status !== "fail")).toBe(true);
	});
});
