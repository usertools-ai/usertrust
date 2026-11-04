// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * S3 witness sink (native SigV4).
 *
 * An AnchorSink inherits the emitter's contract: a publish that resolves means
 * the record was DURABLY accepted, and a publish that rejects keeps the record
 * in the outbox for redelivery. Everything here therefore fails closed: a sink
 * that resolved on a response it did not fully understand would silently drop
 * a record out of the append-only store, which is precisely the evidence loss
 * anchoring exists to prevent.
 *
 * Network access is confined to `httpTransport` at the bottom of this file;
 * every other function is pure, so tests inject a transport and assert on bytes.
 */

import type { AnchorSink } from "./anchor.js";
import { canonicalize } from "./canonical.js";
import { type SigV4Credentials, sigV4Headers } from "./sigv4.js";

/**
 * Injectable HTTP transport — the sink's only impure edge. Structurally
 * identical to anchor-doctor's, so a caller may share one transport across
 * both without either module importing the other.
 */
export type HttpTransport = (opts: {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

export interface S3SinkConfig {
	bucket: string;
	region: string;
	prefix?: string;
	endpoint?: string;
}

// ── Shared helpers ──

const is2xx = (status: number): boolean => status >= 200 && status < 300;

/**
 * A store's response body on its way into an error message. Anything that looks
 * like a signed header is dropped: a hostile or misconfigured endpoint can echo
 * our request back, and an error string ends up in logs and issue trackers
 * (delta D6). Truncated to 120 characters — the status code carries the meaning.
 */
function snippet(body: string): string {
	if (body === "") return "";
	const scrubbed = body
		.replace(/authorization[^\n]*/gi, "[redacted]")
		.replace(/x-amz-security-token[^\n]*/gi, "[redacted]")
		.replace(/AWS4-HMAC-SHA256[^\n]*/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return scrubbed === "" ? "" : `: ${scrubbed.slice(0, 120)}`;
}

const seq12 = (anchorSeq: number): string => String(anchorSeq).padStart(12, "0");

/** `YYYYMMDDTHHMMSSZ` for SigV4. */
function amzDate(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function credentialsFromEnv(): SigV4Credentials | null {
	const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) return null;
	const sessionToken = process.env.AWS_SESSION_TOKEN;
	return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

// ── S3 sink ──

/**
 * Endpoint rule. Plaintext is refused off-loopback: SigV4 authenticates the
 * request but does not encrypt it, so an http endpoint on the network would put
 * the credential-bearing headers on the wire. Loopback is allowed for dev
 * MinIO/LocalStack.
 */
export function parseEndpoint(endpoint: string, sinkName = "s3 sink"): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`${sinkName}: endpoint must include a scheme, got "${endpoint.slice(0, 60)}"`);
	}
	const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
	if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
		throw new Error(
			`${sinkName}: endpoint must be https (http is allowed only for localhost/127.0.0.1), got "${url.protocol}//${url.host}"`,
		);
	}
	return url;
}

/**
 * Object key + addressing. Virtual-host style against AWS; path-style against a
 * configured endpoint, since S3-compatible stores rarely serve bucket
 * subdomains. Anchor records are a few hundred bytes — one PUT, no multipart.
 */
function s3Target(
	cfg: S3SinkConfig,
	vaultId: string,
	anchorSeq: number,
): { host: string; path: string; url: string } {
	const prefix = (cfg.prefix ?? "anchors").replace(/^\/+|\/+$/g, "");
	const key = `${prefix === "" ? "" : `${prefix}/`}${vaultId}/${seq12(anchorSeq)}.json`;
	const encoded = key.split("/").map(encodeURIComponent).join("/");

	if (cfg.endpoint !== undefined) {
		const base = parseEndpoint(cfg.endpoint);
		const path = `/${encodeURIComponent(cfg.bucket)}/${encoded}`;
		return { host: base.host, path, url: `${base.protocol}//${base.host}${path}` };
	}
	const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
	return { host, path: `/${encoded}`, url: `https://${host}/${encoded}` };
}

/**
 * PUT one canonical record per object, keyed by vault and anchorSeq. Immutability
 * is the STORE's job (Object Lock retention / a deny-delete bucket policy);
 * `usertrust anchor doctor` reports whether this identity's permissions match
 * that intent.
 */
export function s3Sink(cfg: S3SinkConfig, transport: HttpTransport = httpTransport): AnchorSink {
	const prefix = (cfg.prefix ?? "anchors").replace(/^\/+|\/+$/g, "");
	return {
		name: `s3:${cfg.bucket}/${prefix}`,
		publish: async (record) => {
			const creds = credentialsFromEnv();
			if (creds === null) {
				throw new Error(
					"s3 sink: AWS credentials not found in environment " +
						"(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)",
				);
			}
			const payload = Buffer.from(canonicalize(record), "utf8");
			const target = s3Target(cfg, record.vaultId, record.anchorSeq);
			const extra = { "content-type": "application/json" };
			const signed = sigV4Headers(
				{
					method: "PUT",
					host: target.host,
					path: target.path,
					headers: extra,
					payload,
					region: cfg.region,
					service: "s3",
					amzDate: amzDate(),
				},
				creds,
			);
			// sigV4Headers signs the caller's headers but returns only its own —
			// both must go on the wire or the signature covers headers that never
			// arrive.
			const res = await transport({
				method: "PUT",
				url: target.url,
				headers: { ...extra, ...signed },
				body: payload,
			});
			if (!is2xx(res.status)) {
				throw new Error(`s3 sink: HTTP ${res.status}${snippet(res.body)}`);
			}
		},
	};
}

// ── Default transport ──

/** The module's only network access. `http://` is reachable for dev endpoints. */
async function httpTransport(opts: {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
	const { request } = await (opts.url.startsWith("http://")
		? import("node:http")
		: import("node:https"));
	return new Promise((resolve, reject) => {
		const req = request(
			opts.url,
			{
				method: opts.method,
				headers: { ...opts.headers, "content-length": String(opts.body.length) },
				timeout: 15_000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const headers: Record<string, string> = {};
					for (const [name, value] of Object.entries(res.headers)) {
						if (typeof value === "string") headers[name] = value;
					}
					resolve({
						status: res.statusCode ?? 0,
						// Bounded: a receipt is small, and an error body is only ever
						// a snippet.
						body: Buffer.concat(chunks)
							.toString("utf8")
							.slice(0, 256 * 1024),
						headers,
					});
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("anchor sink: request timeout")));
		req.on("error", reject);
		req.end(opts.body);
	});
}
