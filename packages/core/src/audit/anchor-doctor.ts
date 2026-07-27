// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `anchor doctor` — append-only store PERMISSION PROBES.
 *
 * What this module establishes is narrow and worth stating precisely: it writes
 * a throwaway probe object to the store and reports whether THIS identity, with
 * the credentials in THIS environment, could delete or overwrite that object
 * RIGHT NOW. It does not prove the store is append-only. A store can deny these
 * operations today and allow them tomorrow, deny them for this identity and
 * allow them for an admin one, or accept an overwrite as a new object version.
 * Immutability comes from the store's own configuration (S3 Object Lock
 * retention, POSIX directory permissions, an appliance's WORM mode) — the
 * doctor only tells an operator whether their configuration is doing anything
 * at all, which is the failure mode worth catching before an audit.
 *
 * The two probes are independent on purpose: on POSIX, deletion is governed by
 * write permission on the DIRECTORY while in-place truncation is governed by
 * permission on the FILE, so a store can deny one and allow the other.
 *
 * The S3 probe leaves its probe object behind whenever the store denies
 * deletion — that is the store working as intended, not a leak, and the probe
 * key is named in every check detail so it can be reconciled or lifecycled.
 *
 * Never in the output: credentials, the `authorization` header, or the session
 * token — a diagnostic that gets pasted into an issue tracker must be safe to
 * paste (plan delta D6).
 */

import { closeSync, openSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { type SigV4Credentials, sigV4Headers } from "./sigv4.js";

export interface DoctorCheck {
	name: string;
	status: "pass" | "fail" | "info";
	detail: string;
}

export interface DoctorReport {
	sink: string;
	checks: DoctorCheck[];
	failed: boolean;
}

/**
 * Injectable HTTP transport — the probe's only impure edge, so tests script
 * store responses instead of reaching the network. Response `headers` are
 * optional because only the S3 versioning probe reads one.
 */
export type HttpTransport = (opts: {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

export interface S3ProbeConfig {
	bucket: string;
	region: string;
	prefix?: string;
	endpoint?: string;
}

const PROBE_BODY = Buffer.from(
	`${JSON.stringify({ probe: "usertrust-anchor-doctor", note: "safe to delete" })}\n`,
	"utf8",
);

// ── Report helpers ──

const pass = (name: string, detail: string): DoctorCheck => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): DoctorCheck => ({ name, status: "fail", detail });
const info = (name: string, detail: string): DoctorCheck => ({ name, status: "info", detail });

function report(sink: string, checks: DoctorCheck[]): DoctorReport {
	return { sink, checks, failed: checks.some((c) => c.status === "fail") };
}

/**
 * Untrusted text (store error bodies, transport error messages) on its way into
 * a check detail. Anything that could carry a signed header is dropped to the
 * end of its line rather than partially masked — a diagnostic is worth less
 * than a credential.
 */
function redact(text: string): string {
	const scrubbed = text
		.replace(/authorization[^\n]*/gi, "[redacted]")
		.replace(/x-amz-security-token[^\n]*/gi, "[redacted]")
		.replace(/AWS4-HMAC-SHA256[^\n]*/g, "[redacted]")
		.replace(/Credential=[^\s,]*/g, "[redacted]")
		.replace(/Signature=[^\s,]*/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return scrubbed.length > 120 ? `${scrubbed.slice(0, 120)}…` : scrubbed;
}

const messageOf = (err: unknown): string =>
	redact(err instanceof Error ? err.message : String(err));

const errnoOf = (err: unknown): string =>
	typeof (err as { code?: unknown }).code === "string" ? (err as { code: string }).code : "unknown";

// ── File sink ──

/**
 * Probe the directory holding a file sink. The probe object is created next to
 * the store file (same directory, hence same permissions) and removed again.
 */
export function doctorFileSink(sinkPath: string): DoctorReport {
	const sink = `file:${sinkPath}`;
	const dir = dirname(sinkPath);
	// PID-scoped so concurrent doctors never probe each other's object; opened
	// with "w" so a stale probe from a crashed run is reused, not fatal.
	const probe = join(dir, `.doctor-probe-${process.pid}`);

	const created = writeProbe(probe);
	if (created !== null) {
		return report(sink, [
			info(
				"probe",
				`cannot probe: this identity could not create a probe object in ${dir} (${created}) — ` +
					"the store's delete and overwrite permissions were not exercised",
			),
		]);
	}

	const checks: DoctorCheck[] = [];
	let deleted = false;
	try {
		unlinkSync(probe);
		deleted = true;
		checks.push(
			fail("delete-denied", `this identity could delete a probe object at ${probe} right now`),
		);
	} catch (err) {
		checks.push(
			pass(
				"delete-denied",
				`this identity could not delete a probe object at ${probe} right now (${errnoOf(err)})`,
			),
		);
	}

	// The delete probe consumed the object when it succeeded; the overwrite
	// probe needs one to truncate.
	const recreated = deleted ? writeProbe(probe) : null;
	if (recreated !== null) {
		checks.push(info("overwrite-denied", `cannot probe overwrite: ${recreated}`));
		return report(sink, checks);
	}

	checks.push(overwriteProbe(probe));
	try {
		unlinkSync(probe);
	} catch {
		// Best effort: a store that refuses the delete is the passing case, and
		// the probe object is named in the check detail either way.
	}
	return report(sink, checks);
}

/** Creates or truncates the probe object; returns an errno on failure, else null. */
function writeProbe(probe: string): string | null {
	try {
		const fd = openSync(probe, "w", 0o600);
		try {
			writeSync(fd, PROBE_BODY);
		} finally {
			closeSync(fd);
		}
		return null;
	} catch (err) {
		return errnoOf(err);
	}
}

function overwriteProbe(probe: string): DoctorCheck {
	const errno = writeProbe(probe);
	return errno === null
		? fail("overwrite-denied", `this identity could overwrite a probe object at ${probe} right now`)
		: pass(
				"overwrite-denied",
				`this identity could not overwrite a probe object at ${probe} right now (${errno})`,
			);
}

// ── S3 sink ──

/**
 * Probe an S3-compatible store: write a probe object, then attempt the two
 * operations an append-only store must refuse against that same key.
 */
export async function doctorS3Sink(
	cfg: S3ProbeConfig,
	transport: HttpTransport = httpsTransport,
): Promise<DoctorReport> {
	const prefix = (cfg.prefix ?? "anchors").replace(/^\/+|\/+$/g, "");
	const sink = `s3:${cfg.bucket}/${prefix}`;

	const creds = credentialsFromEnv();
	if (creds === null) {
		return report(sink, [
			info(
				"probe",
				"cannot probe: AWS credentials not found in the environment " +
					"(AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)",
			),
		]);
	}

	const target = probeTarget(cfg, prefix);
	const loc = `s3://${cfg.bucket}/${target.key}`;
	const send = (method: string, payload: Buffer) =>
		s3Request(transport, target, cfg.region, method, payload, creds);

	const put = await attempt(() => send("PUT", PROBE_BODY));
	if (put.error !== null) {
		return report(sink, [info("probe", `cannot probe: writing ${loc} failed — ${put.error}`)]);
	}
	if (!is2xx(put.status)) {
		return report(sink, [
			info(
				"probe",
				`cannot probe: writing ${loc} returned HTTP ${put.status}${snippet(put.body)} — ` +
					"the store's delete and overwrite permissions were not exercised",
			),
		]);
	}

	return report(sink, [
		verdict("delete-denied", "delete", loc, await attempt(() => send("DELETE", Buffer.alloc(0)))),
		verdict("overwrite-denied", "overwrite", loc, await attempt(() => send("PUT", PROBE_BODY))),
	]);
}

interface Attempt {
	status: number;
	body: string;
	versionId: string | null;
	error: string | null;
}

async function attempt(
	run: () => Promise<{ status: number; body: string; headers?: Record<string, string> }>,
): Promise<Attempt> {
	try {
		const res = await run();
		const headers = res.headers ?? {};
		const versionId =
			Object.entries(headers).find(([k]) => k.toLowerCase() === "x-amz-version-id")?.[1] ?? null;
		return { status: res.status, body: res.body, versionId, error: null };
	} catch (err) {
		return { status: 0, body: "", versionId: null, error: messageOf(err) };
	}
}

/**
 * Turn one store response into a verdict. 403 is the shape a store takes when
 * its policy refuses; a 2xx that carries `x-amz-version-id` is neither a
 * refusal nor a true overwrite, so it reports as info rather than a verdict.
 */
function verdict(name: string, op: "delete" | "overwrite", loc: string, res: Attempt): DoctorCheck {
	if (res.error !== null) {
		return info(name, `cannot probe ${op}: ${loc} — ${res.error}`);
	}
	if (res.status === 403) {
		return pass(
			name,
			`this identity could not ${op} a probe object at ${loc} right now (HTTP 403)`,
		);
	}
	if (!is2xx(res.status)) {
		return info(
			name,
			`inconclusive: ${op} of ${loc} returned HTTP ${res.status}${snippet(res.body)}`,
		);
	}
	if (op === "overwrite" && res.versionId !== null) {
		return info(
			name,
			`this identity could write a new version of a probe object at ${loc} right now ` +
				`(HTTP ${res.status}, x-amz-version-id) — a new version does not remove the previous ` +
				"one; confirm Object Lock retention denies deletion of individual versions",
		);
	}
	return fail(
		name,
		`this identity could ${op} a probe object at ${loc} right now (HTTP ${res.status})`,
	);
}

const is2xx = (status: number): boolean => status >= 200 && status < 300;

const snippet = (body: string): string => (body === "" ? "" : `: ${redact(body)}`);

function credentialsFromEnv(): SigV4Credentials | null {
	const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
	const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
	if (!accessKeyId || !secretAccessKey) return null;
	const sessionToken = process.env.AWS_SESSION_TOKEN;
	return { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) };
}

interface ProbeTarget {
	host: string;
	path: string;
	url: string;
	key: string;
}

/** Virtual-host addressing by default; path-style when an endpoint is configured. */
function probeTarget(cfg: S3ProbeConfig, prefix: string): ProbeTarget {
	const key = `${prefix === "" ? "" : `${prefix}/`}doctor-probe/${process.pid}-${amzDate()}.json`;
	const encoded = key.split("/").map(encodeURIComponent).join("/");

	if (cfg.endpoint !== undefined) {
		const base = parseEndpoint(cfg.endpoint);
		const path = `/${encodeURIComponent(cfg.bucket)}/${encoded}`;
		return { host: base.host, path, url: `${base.protocol}//${base.host}${path}`, key };
	}
	const host = `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
	return { host, path: `/${encoded}`, url: `https://${host}/${encoded}`, key };
}

function parseEndpoint(endpoint: string): URL {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		throw new Error(`s3 doctor: endpoint must include a scheme, got "${endpoint.slice(0, 60)}"`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`s3 doctor: endpoint scheme must be http(s), got "${url.protocol}"`);
	}
	return url;
}

/** `YYYYMMDDTHHMMSSZ` — also the probe key's uniqueness across runs. */
function amzDate(): string {
	return `${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
}

function s3Request(
	transport: HttpTransport,
	target: ProbeTarget,
	region: string,
	method: string,
	payload: Buffer,
	creds: SigV4Credentials,
): Promise<{ status: number; body: string; headers?: Record<string, string> }> {
	const extra = payload.length > 0 ? { "content-type": "application/json" } : {};
	const signed = sigV4Headers(
		{
			method,
			host: target.host,
			path: target.path,
			headers: extra,
			payload,
			region,
			service: "s3",
			amzDate: amzDate(),
		},
		creds,
	);
	// sigV4Headers signs caller headers but returns only its own — the caller
	// must send both, or the signature covers headers that never arrive.
	return transport({ method, url: target.url, headers: { ...extra, ...signed }, body: payload });
}

/** Default transport. `http://` endpoints (dev MinIO) require an injected one. */
async function httpsTransport(opts: {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: Buffer;
}): Promise<{ status: number; body: string; headers: Record<string, string> }> {
	const { request } = await import("node:https");
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
						body: Buffer.concat(chunks).toString("utf8").slice(0, 4096),
						headers,
					});
				});
			},
		);
		req.on("timeout", () => req.destroy(new Error("s3 doctor: request timeout")));
		req.on("error", reject);
		req.end(opts.body);
	});
}
