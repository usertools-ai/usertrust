// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * AWS Signature Version 4 — pure signer for the S3 anchor sink.
 *
 * Node built-ins only: pulling an AWS SDK in for four HMACs would put a
 * multi-megabyte transitive dependency tree behind the audit trail, which is
 * exactly what the anchoring design refuses to do.
 *
 * Every function here is pure — `amzDate` is supplied by the caller rather than
 * read from the clock, so signatures are reproducible in tests and validated
 * against AWS's published test vector (see tests/audit/sigv4.test.ts).
 *
 * Scope: SigV4 for requests whose payload is fully in memory (anchor records
 * are a few hundred bytes). No streaming/chunked signing, no multipart.
 *
 * Credentials are never logged, echoed into errors, or returned — only the
 * derived `authorization` header leaves this module.
 */

import { createHash, createHmac } from "node:crypto";

const ALGORITHM = "AWS4-HMAC-SHA256";
const TERMINATOR = "aws4_request";
const AMZ_DATE = /^\d{8}T\d{6}Z$/;

// ── Types ──

export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface SigV4Request {
	method: string;
	/** Virtual-host or path-style host, no scheme. Signed as the `host` header. */
	host: string;
	/** Already URI-encoded absolute path, e.g. `/bucket/key`. */
	path: string;
	/** Canonical (sorted, encoded) query string; empty when absent. */
	query?: string;
	/** Lowercase-normalized on the way in; `host` is supplied by `host` above. */
	headers: Record<string, string>;
	payload: Buffer;
	region: string;
	service: string;
	/** `YYYYMMDDTHHMMSSZ` — injected rather than read from the clock. */
	amzDate: string;
}

// ── Primitives ──

function hmac(key: Buffer | string, data: string): Buffer {
	return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * The `YYYYMMDD` half of an amz date. A malformed date would otherwise be
 * signed into a credential scope AWS cannot resolve, surfacing as an opaque
 * 403 at publish time; fail here instead, where the cause is visible.
 */
function date8Of(amzDate: string): string {
	if (!AMZ_DATE.test(amzDate)) {
		throw new Error(`sigv4: amzDate must be YYYYMMDDTHHMMSSZ, got "${amzDate.slice(0, 32)}"`);
	}
	return amzDate.slice(0, 8);
}

function credentialScope(date8: string, region: string, service: string): string {
	return `${date8}/${region}/${service}/${TERMINATOR}`;
}

/** sha256 hex of the request payload — S3 requires it as `x-amz-content-sha256`. */
export function hashPayload(payload: Buffer): string {
	return createHash("sha256").update(payload).digest("hex");
}

/**
 * Canonical request plus the `;`-joined list of header names it signs.
 *
 * Header values are normalized the way AWS re-normalizes them server-side
 * (trimmed, inner runs of spaces collapsed) so a value carrying incidental
 * whitespace still verifies.
 */
function canonicalParts(
	req: SigV4Request,
	payloadHash: string,
): { canonical: string; signedHeaders: string } {
	const merged = new Map<string, string>();
	for (const [name, value] of Object.entries(req.headers)) {
		merged.set(name.trim().toLowerCase(), value.trim().replace(/ {2,}/g, " "));
	}
	// These three are ours: a caller-supplied `host` header must never decide
	// what the signature covers, and the digest must match the bytes we send.
	merged.set("host", req.host);
	merged.set("x-amz-date", req.amzDate);
	merged.set("x-amz-content-sha256", payloadHash);

	// Map keys are unique, so a comparator that never returns 0 is still total.
	const entries = [...merged].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	const signedHeaders = entries.map(([name]) => name).join(";");
	const canonical = [
		req.method.toUpperCase(),
		req.path,
		req.query ?? "",
		entries.map(([name, value]) => `${name}:${value}\n`).join(""),
		signedHeaders,
		payloadHash,
	].join("\n");
	return { canonical, signedHeaders };
}

/**
 * `METHOD\n<path>\n<query>\n<canonicalHeaders>\n<signedHeaders>\n<payloadHash>`
 * — canonicalHeaders is a sorted `name:value\n` block, hence the blank line
 * before the signed-header list.
 */
export function canonicalRequest(req: SigV4Request, payloadHash: string): string {
	return canonicalParts(req, payloadHash).canonical;
}

/** `AWS4-HMAC-SHA256\n<amzDate>\n<scope>\n<sha256hex(canonicalRequest)>`. */
export function stringToSign(req: SigV4Request, canonicalReqSha256: string): string {
	const date8 = date8Of(req.amzDate);
	return [
		ALGORITHM,
		req.amzDate,
		credentialScope(date8, req.region, req.service),
		canonicalReqSha256,
	].join("\n");
}

/**
 * The date/region/service-scoped derived key. Scoping is what keeps a leaked
 * signature from being replayable outside its day, region and service.
 */
export function signingKey(secret: string, date8: string, region: string, service: string): Buffer {
	const kDate = hmac(`AWS4${secret}`, date8);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, service);
	return hmac(kService, TERMINATOR);
}

/**
 * Headers to add to the outbound request: `host`, `x-amz-date`,
 * `x-amz-content-sha256`, `authorization`, and `x-amz-security-token` when the
 * credentials are temporary. Caller-supplied headers are signed but not
 * returned — the caller already has them and must send them verbatim.
 */
export function sigV4Headers(req: SigV4Request, creds: SigV4Credentials): Record<string, string> {
	const date8 = date8Of(req.amzDate);
	const payloadHash = hashPayload(req.payload);
	// The session token is part of the signature, not just a header alongside it.
	const signReq: SigV4Request = creds.sessionToken
		? { ...req, headers: { ...req.headers, "x-amz-security-token": creds.sessionToken } }
		: req;

	const { canonical, signedHeaders } = canonicalParts(signReq, payloadHash);
	const canonicalHash = createHash("sha256").update(canonical, "utf8").digest("hex");
	const key = signingKey(creds.secretAccessKey, date8, req.region, req.service);
	const signature = hmac(key, stringToSign(signReq, canonicalHash)).toString("hex");

	const scope = credentialScope(date8, req.region, req.service);
	const out: Record<string, string> = {
		host: req.host,
		"x-amz-date": req.amzDate,
		"x-amz-content-sha256": payloadHash,
		authorization:
			`${ALGORITHM} Credential=${creds.accessKeyId}/${scope}, ` +
			`SignedHeaders=${signedHeaders}, Signature=${signature}`,
	};
	if (creds.sessionToken) {
		out["x-amz-security-token"] = creds.sessionToken;
	}
	return out;
}
