// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Witness sinks: S3 (native SigV4) and Rekor (hashedrekord transparency log).
 *
 * Both are AnchorSinks, so both inherit the emitter's contract: a publish that
 * resolves means the record was DURABLY accepted, and a publish that rejects
 * keeps the record in the outbox for redelivery. Everything here therefore
 * fails closed — a sink that resolved on a response it did not fully understand
 * would silently drop a record out of the append-only store, which is precisely
 * the evidence loss anchoring exists to prevent.
 *
 * What Rekor witnesses is deliberately thin (spec §3, delta D14): the entry
 * carries sha256 of the anchor payload, the record's signature, and the vault's
 * public key — never event data, never the payload itself. The receipt lives in
 * its own file because the anchor record schema is FROZEN; a transparency log
 * must not become a field inside the thing it witnesses.
 *
 * EXPERIMENTAL: the Rekor path is exercised against synthetic responses only —
 * the live API is untested in CI, and the entry `apiVersion` is pinned to
 * 0.0.1.
 *
 * Network access is confined to `httpTransport` at the bottom of this file;
 * every other function is pure or writes to the vault, so tests inject a
 * transport and assert on bytes.
 */

import { createHash } from "node:crypto";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
// Cyclic by design: anchor.ts builds these sinks from SinkConfig, and the Rekor
// sink needs the vault's identity + anchors directory. Both bindings are
// function declarations used only at publish time, so the cycle never observes
// a partially initialized module.
import { type AnchorIdentity, type AnchorSink, anchorsDir, readAnchorIdentity } from "./anchor.js";
import { type AnchorRecord, anchorPayloadHash } from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { parseRekorReceipt, type RekorReceipt } from "./rekor-verify.js";
import { type SigV4Credentials, sigV4Headers } from "./sigv4.js";

export const DEFAULT_REKOR_URL = "https://rekor.sigstore.dev";
const REKOR_ENTRIES_PATH = "/api/v1/log/entries";

/** Rekor's hashedrekord schema version. Pinned: 0.0.2+ changes the spec shape. */
const HASHEDREKORD_API_VERSION = "0.0.1";

const HEX64 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_ENTRY_BODY_BYTES = 64 * 1024;
const MAX_CHECKPOINT_BYTES = 8 * 1024;
const MAX_INCLUSION_PATH = 64;
const MAX_SET_BYTES = 1024;
/** Matches the receipt parser's bound: `* 1000` must stay a valid Date. */
const MAX_INTEGRATED_TIME = 8_640_000_000_000;

/**
 * Injectable HTTP transport — the sinks' only impure edge. Structurally
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
 * Endpoint rule for BOTH sinks. Plaintext is refused off-loopback: for S3,
 * SigV4 authenticates the request but does not encrypt it, so an http endpoint
 * on the network would put the credential-bearing headers on the wire; for
 * Rekor, an http log URL lets anyone on the path answer for the witness — and
 * a sink that accepts a forged 201 files forged evidence. Loopback is allowed
 * for dev MinIO/LocalStack and local log instances.
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

// ── Rekor entry proposal ──

/**
 * SPKI base64 as PEM text. The exact bytes matter: this text is base64'd into
 * the entry, and the entry's bytes are what the inclusion proof commits to
 * (delta D13). 64-character lines, LF-only, trailing newline.
 */
function pemFromSpkiBase64(spkiBase64: string): string {
	const compact = spkiBase64.replace(/\s+/g, "");
	if (compact === "" || !BASE64.test(compact)) {
		throw new Error("rekor sink: vault identity publicKeySpki is not base64");
	}
	const wrapped = (compact.match(/.{1,64}/g) ?? []).join("\n");
	return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/**
 * The hashedrekord entry we PROPOSE for a record: the anchor payload hash as the
 * artifact, the record's Ed25519 signature, and the vault's public key. The log
 * stores its own serialization of this; the receipt carries the log's bytes, so
 * these are the bytes we sign nothing over and merely offer.
 */
export function buildHashedRekordEntry(record: AnchorRecord, publicKeySpkiBase64: string): string {
	return canonicalize({
		apiVersion: HASHEDREKORD_API_VERSION,
		kind: "hashedrekord",
		spec: {
			data: { hash: { algorithm: "sha256", value: anchorPayloadHash(record) } },
			signature: {
				content: record.sig,
				publicKey: {
					content: Buffer.from(pemFromSpkiBase64(publicKeySpkiBase64), "utf8").toString("base64"),
				},
			},
		},
	});
}

// ── Rekor 201 validation ──

interface AcceptedEntry {
	/** base64 of the bytes the LOG stored, verbatim. */
	body: string;
	integratedTime: number;
	logIndex: number;
	treeSize: number;
	rootHash: string;
	hashes: string[];
	checkpoint: string;
	/** The log's signature over integratedTime — absent on logs that omit it. */
	signedEntryTimestamp?: string;
	logID?: string;
}

function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function isSafeIntAtLeast(value: unknown, min: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

/**
 * Validate a 201 down to every field the receipt will quote. A receipt built
 * from a half-understood response is worse than no receipt: it would be filed as
 * evidence and only fail at audit time, long after the anchor left the outbox.
 * Nothing from the response is echoed into these errors — field names only.
 */
function parseAcceptedEntry(raw: string): { entry: AcceptedEntry | null; error: string | null } {
	const bad = (message: string): { entry: null; error: string } => ({
		entry: null,
		error: message,
	});

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return bad("body is not valid JSON");
	}
	const response = asObject(parsed);
	if (response === null) return bad("body is not a JSON object");
	const uuids = Object.keys(response);
	// Rekor keys the response by entry UUID. Two keys means the log is answering
	// about an entry we did not propose; zero means it answered about none.
	if (uuids.length !== 1) return bad(`expected exactly one entry, got ${uuids.length}`);
	const entry = asObject(response[uuids[0] as string]);
	if (entry === null) return bad("entry is not a JSON object");

	if (typeof entry.body !== "string" || entry.body === "" || !BASE64.test(entry.body)) {
		return bad("entry.body must be base64");
	}
	const decoded = Buffer.from(entry.body, "base64");
	if (decoded.length === 0) return bad("entry.body decodes to no bytes");
	if (decoded.length > MAX_ENTRY_BODY_BYTES) return bad("entry.body exceeds 64 KiB decoded");
	if (!isSafeIntAtLeast(entry.logIndex, 0))
		return bad("entry.logIndex must be a safe integer >= 0");
	// Same bound the receipt parser enforces: a receipt we write must be one we
	// can read back, and `integratedTime * 1000` has to stay a printable Date.
	if (!isSafeIntAtLeast(entry.integratedTime, 1) || entry.integratedTime >= MAX_INTEGRATED_TIME) {
		return bad(`entry.integratedTime must be a safe integer > 0 and < ${MAX_INTEGRATED_TIME}`);
	}
	if (entry.logID !== undefined && (typeof entry.logID !== "string" || !HEX64.test(entry.logID))) {
		return bad("entry.logID must be 64 lowercase hex characters");
	}

	const verification = asObject(entry.verification);
	const proof = asObject(verification?.inclusionProof);
	if (proof === null) return bad("entry.verification.inclusionProof is missing");
	// The proof's own index — NOT the entry's global logIndex, which counts
	// across the whole log rather than the tree this proof is against.
	if (!isSafeIntAtLeast(proof.logIndex, 0)) return bad("inclusionProof.logIndex must be >= 0");
	if (!isSafeIntAtLeast(proof.treeSize, 1)) return bad("inclusionProof.treeSize must be >= 1");
	if (proof.logIndex >= proof.treeSize) {
		return bad("inclusionProof.logIndex must be < inclusionProof.treeSize");
	}
	if (typeof proof.rootHash !== "string" || !HEX64.test(proof.rootHash)) {
		return bad("inclusionProof.rootHash must be 64 lowercase hex characters");
	}
	if (!Array.isArray(proof.hashes) || proof.hashes.length > MAX_INCLUSION_PATH) {
		return bad(`inclusionProof.hashes must be an array of at most ${MAX_INCLUSION_PATH} hashes`);
	}
	for (const h of proof.hashes) {
		if (typeof h !== "string" || !HEX64.test(h)) {
			return bad("inclusionProof.hashes entries must be 64 lowercase hex characters");
		}
	}
	if (
		typeof proof.checkpoint !== "string" ||
		proof.checkpoint === "" ||
		Buffer.byteLength(proof.checkpoint, "utf8") > MAX_CHECKPOINT_BYTES ||
		proof.checkpoint.includes("\r")
	) {
		return bad("inclusionProof.checkpoint must be a non-empty LF-only string of at most 8 KiB");
	}

	// The signed entry timestamp is what makes integratedTime worth anything to
	// an auditor, so it is captured whenever the log offers one — but a SET with
	// no logID cannot be verified by anybody (the logID is inside the payload it
	// signs), and filing evidence nobody can check is the failure this module
	// exists to avoid.
	const set = verification?.signedEntryTimestamp;
	if (set !== undefined) {
		if (
			typeof set !== "string" ||
			set === "" ||
			!BASE64.test(set) ||
			Buffer.byteLength(set, "utf8") > MAX_SET_BYTES
		) {
			return bad("verification.signedEntryTimestamp must be base64 of at most 1 KiB");
		}
		if (entry.logID === undefined) {
			return bad("verification.signedEntryTimestamp present without entry.logID");
		}
	}

	return {
		entry: {
			body: entry.body,
			integratedTime: entry.integratedTime,
			logIndex: proof.logIndex,
			treeSize: proof.treeSize,
			rootHash: proof.rootHash,
			hashes: proof.hashes as string[],
			checkpoint: proof.checkpoint,
			...(typeof set === "string" ? { signedEntryTimestamp: set } : {}),
			...(typeof entry.logID === "string" ? { logID: entry.logID } : {}),
		},
		error: null,
	};
}

// ── Receipt persistence ──

/**
 * `<seq12>.<8 hex of sha256(log url)>.json` — one receipt per (anchor, LOG).
 * Keying by anchorSeq alone made two rekor sinks silently overwrite each
 * other's evidence: the second witness's receipt replaced the first's, and the
 * operator ended up with fewer independent attestations than they configured.
 * Readers glob `*.json` in this directory, so pre-existing `<seq12>.json`
 * receipts keep being found.
 */
export function rekorReceiptPath(rootDir: string, anchorSeq: number, logUrl: string): string {
	const tag = createHash("sha256").update(logUrl, "utf8").digest("hex").slice(0, 8);
	return join(anchorsDir(rootDir), "rekor", `${seq12(anchorSeq)}.${tag}.json`);
}

/** Fsync'd receipt write — the same durability the outbox and mirror get. */
function writeReceipt(rootDir: string, receipt: RekorReceipt): void {
	const serialized = `${canonicalize(receipt)}\n`;
	// A receipt our own parser rejects is a bug in this module, and it would be
	// discovered at audit time by whoever is relying on it. Fail here instead.
	const check = parseRekorReceipt(serialized);
	if (check.receipt === null) {
		throw new Error(`rekor sink: assembled an unparseable receipt (${check.error})`);
	}
	const dir = join(anchorsDir(rootDir), "rekor");
	mkdirSync(dir, { recursive: true });
	const fd = openSync(rekorReceiptPath(rootDir, receipt.anchorSeq, receipt.log.url), "w", 0o600);
	try {
		writeSync(fd, serialized);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Do the bytes a log stored commit to THIS record — our payload hash AND our
 * signature? Reused for the 201 response and for receipts already on disk; in
 * both cases the alternative is filing evidence about someone else's entry.
 * Decoded bytes are compared, never base64 spellings, since base64 is not
 * canonical and equivalent encodings are the same signature.
 */
function entryBindsRecord(entryBodyBase64: string, record: AnchorRecord): boolean {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(entryBodyBase64, "base64").toString("utf8"));
	} catch {
		return false;
	}
	const spec = asObject(asObject(parsed)?.spec);
	if (spec === null) return false;
	const hash = asObject(asObject(spec.data)?.hash);
	const signature = asObject(spec.signature);
	if (hash === null || signature === null || typeof signature.content !== "string") return false;
	if (hash.value !== anchorPayloadHash(record)) return false;
	const logged = Buffer.from(signature.content, "base64");
	const ours = Buffer.from(record.sig, "base64");
	return ours.length > 0 && logged.equals(ours);
}

/**
 * A receipt already on disk from THIS log that witnesses THIS record. Every
 * `*.json` in the directory is considered, because the filename is a
 * convenience and the receipt's own contents are the evidence — a receipt is
 * only accepted when it names the record, carries its payload hash, and its
 * stored entry binds the record's signature.
 */
function findBindingReceipt(rootDir: string, record: AnchorRecord, logUrl: string): boolean {
	const dir = join(anchorsDir(rootDir), "rekor");
	let names: string[];
	try {
		names = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return false;
	}
	for (const name of names.sort()) {
		let raw: string;
		try {
			raw = readFileSync(join(dir, name), "utf-8");
		} catch {
			continue;
		}
		const { receipt } = parseRekorReceipt(raw);
		if (receipt === null) continue;
		if (
			receipt.vaultId === record.vaultId &&
			receipt.anchorSeq === record.anchorSeq &&
			receipt.log.url === logUrl &&
			receipt.artifactHash === anchorPayloadHash(record) &&
			entryBindsRecord(receipt.entryBody, record)
		) {
			return true;
		}
	}
	return false;
}

/**
 * The public key to PROPOSE for a record, resolved from the record's OWN key
 * epoch rather than from whatever key the vault holds today. A record minted
 * before a rotation and redelivered after it is still signed by the old key, so
 * proposing the live key would log a public key that does not verify the
 * signature sitting beside it — a permanently wrong entry in an append-only
 * log. Identities predating key history keep the old behavior; once a history
 * exists, a keyId absent from it is refused rather than guessed at.
 */
function spkiForRecord(identity: AnchorIdentity, record: AnchorRecord): string {
	if (identity.keyHistory === undefined) return identity.publicKeySpki;
	const known = [
		...identity.keyHistory,
		{ keyId: identity.keyId, publicKeySpki: identity.publicKeySpki },
	];
	const match = known.find((entry) => entry.keyId === record.keyId);
	if (match === undefined) {
		throw new Error(
			`rekor sink: no public key for keyId ${record.keyId} in this vault's key history`,
		);
	}
	return match.publicKeySpki;
}

// ── Rekor sink ──

/**
 * Publish a record's payload hash to a Rekor transparency log and persist the
 * inclusion receipt next to the mirror.
 *
 * A 409 means the log already holds an entry for this proposal, which happens
 * on exactly one honest path: a crash between writing the receipt and clearing
 * the outbox, so the emitter redelivers a record that IS already witnessed.
 * That case is resolved from the receipt we already hold — never from the 409
 * itself, which carries no evidence. A 409 with no such receipt is a duplicate
 * we cannot account for, and fabricating one from a Location header would mean
 * filing evidence about bytes we never saw (delta D1), so it rejects and the
 * outbox keeps the record for a human.
 */
export function rekorSink(
	rootDir: string,
	url: string = DEFAULT_REKOR_URL,
	transport: HttpTransport = httpTransport,
): AnchorSink {
	// Same rule as the S3 sink, applied at CONSTRUCTION so a plaintext log URL
	// fails before a record is ever offered to it.
	parseEndpoint(url, "rekor sink");
	const base = url.replace(/\/+$/, "");
	return {
		name: `rekor:${base}`,
		publish: async (record) => {
			const identity = readAnchorIdentity(rootDir);
			if (identity === null) {
				throw new Error("rekor sink: no anchor identity — run `usertrust anchor init` first");
			}
			const proposal = Buffer.from(
				buildHashedRekordEntry(record, spkiForRecord(identity, record)),
				"utf8",
			);
			const res = await transport({
				method: "POST",
				url: `${base}${REKOR_ENTRIES_PATH}`,
				headers: {
					accept: "application/json",
					"content-type": "application/json",
				},
				body: proposal,
			});
			if (res.status === 409) {
				if (findBindingReceipt(rootDir, record, base)) return;
				throw new Error(
					"rekor sink: HTTP 409 (duplicate without local receipt — fetch the entry manually)",
				);
			}
			if (res.status !== 201) {
				throw new Error(`rekor sink: HTTP ${res.status}${snippet(res.body)}`);
			}
			const { entry, error } = parseAcceptedEntry(res.body);
			if (entry === null) {
				throw new Error(`rekor sink: invalid 201 response: ${error}`);
			}
			// A well-formed 201 is not yet OUR 201: the receipt is built from the
			// log's bytes, so a response describing somebody else's entry would be
			// persisted as evidence for this record and only fall apart at audit
			// time. Bind it to the record before trusting a single field of it.
			if (!entryBindsRecord(entry.body, record)) {
				throw new Error(
					"rekor sink: 201 response describes an entry that is not this record's " +
						"(payload hash or signature mismatch)",
				);
			}
			writeReceipt(rootDir, {
				v: 1,
				vaultId: record.vaultId,
				anchorSeq: record.anchorSeq,
				artifactHash: anchorPayloadHash(record),
				// VERBATIM (delta D13): the leaf hash is over the bytes the LOG
				// stored, so any reserialization here would break inclusion.
				entryBody: entry.body,
				log: {
					url: base,
					logIndex: entry.logIndex,
					treeSize: entry.treeSize,
					rootHash: entry.rootHash,
					hashes: entry.hashes,
					checkpoint: entry.checkpoint,
					integratedTime: entry.integratedTime,
					...(entry.signedEntryTimestamp !== undefined
						? { signedEntryTimestamp: entry.signedEntryTimestamp }
						: {}),
					...(entry.logID !== undefined ? { logID: entry.logID } : {}),
				},
			});
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
