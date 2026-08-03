// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * External Anchor Emitter — signed chain-head checkpoints
 *
 * Periodically commits the audit chain's head (Merkle root + size + last
 * hash), Ed25519-signed and hash-chained to the previous checkpoint, to an
 * append-only store the vault operator cannot silently rewrite. Spec:
 * docs/superpowers/specs/2026-07-26-external-anchoring-design.md §5.
 *
 * Additive by construction: the append path (events.jsonl / .meta bytes) is
 * untouched; the emitter only OBSERVES the writer's outputs. Emission is
 * serialized by its own advisory lock (`audit/anchors/.anchor-writer.lock`)
 * so an in-process scheduler and a cron-driven `usertrust anchor now` cannot
 * race the mirror and mint fork evidence. `appendEvent` never blocks on any
 * of this.
 *
 * The vault-local mirror (`audit/anchors/anchors.jsonl`) is a CACHE — trust
 * comes from the external store copies. The private key NEVER lives inside
 * the vault.
 */

import { spawn } from "node:child_process";
import {
	createPrivateKey,
	createPublicKey,
	sign as cryptoSign,
	generateKeyPairSync,
	randomUUID,
} from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { GENESIS_HASH, VAULT_DIR } from "../shared/constants.js";
import {
	type AnchorRecord,
	anchorPayloadHash,
	anchorSigningPreimage,
	gatherOrderedEventHashes,
	keyIdFromKeyObject,
	parseAnchorRecord,
	parseAnchorsContent,
	publicKeyFromSpkiBase64,
	verifySignatureRaw,
} from "./anchor-verify.js";
import { canonicalize } from "./canonical.js";
import { buildMerkleTree } from "./merkle.js";
import { DEFAULT_REKOR_URL, rekorSink, s3Sink } from "./rekor.js";

// ── Config types (spec §5.4) ──

export type AnchorSignerConfig =
	| { type: "pem"; env?: string; file?: string }
	| {
			/** Non-exportable key (KMS/HSM/PKCS#11/Vault-transit). The key never
			 * touches this host; the backend signs the §3 pre-image. Bounds key
			 * exfiltration — but does NOT defeat an attacker who can drive it as
			 * a signing oracle; the append-only witness is the anti-A1 control. */
			type: "external";
			keyId: string;
			publicKeySpki: string;
			sign(preimage: Uint8Array): Promise<Uint8Array>;
	  };

export type SinkConfig =
	| { type: "file"; path: string }
	| { type: "https"; url: string; headers?: Record<string, string> }
	| { type: "command"; argv: string[] }
	/** S3-compatible object store, one object per record, SigV4-signed. */
	| { type: "s3"; bucket: string; region: string; prefix?: string; endpoint?: string }
	/** Rekor transparency log (EXPERIMENTAL). Defaults to rekor.sigstore.dev. */
	| { type: "rekor"; url?: string };

export interface AnchorSink {
	readonly name: string;
	/** MUST be append-only from the writer's credentials. Resolve = durably accepted. */
	publish(record: AnchorRecord): Promise<void>;
}

export interface AnchoringConfig {
	signer: AnchorSignerConfig;
	cadence?: { everyEvents?: number; everyMs?: number };
	/** Declarative sink configs and/or pre-built AnchorSink instances. */
	sinks?: (SinkConfig | AnchorSink)[];
	/** Per-publish retry attempts (exponential backoff + jitter). Default 5. */
	publishRetries?: number;
}

export interface AnchorEmitterStatus {
	lastAnchor: { anchorSeq: number; treeSize: number; timestamp: string } | null;
	eventsSinceLastAnchor: number;
	msSinceLastAnchor: number | null;
	outboxDepth: number;
	anchorSkips: number;
	publishFailures: number;
	degraded: boolean;
	/** Last emit-cycle error surfaced by the scheduler (null when healthy). */
	lastEmitError: string | null;
}

export interface AnchorEmitResult {
	emitted: boolean;
	record?: AnchorRecord;
	reason?: string;
}

export interface AnchorEmitter {
	/** One snapshot→sign→mirror→publish cycle (spec §5.1). */
	anchorNow(): Promise<AnchorEmitResult>;
	/** Emit a rotation record cross-signed by the CURRENT key (spec §6). */
	rotate(next: { keyId: string; publicKeySpki: string }): Promise<AnchorEmitResult>;
	status(): AnchorEmitterStatus;
	/** Start the cadence scheduler (unref'd timer; never blocks appends). */
	start(): void;
	stop(): Promise<void>;
	/** Mirror records with anchorSeq > since, for pull-mode shipping. */
	exportSince(since: number): AnchorRecord[];
}

export const DEFAULT_ANCHOR_EVERY_EVENTS = 1000;
export const DEFAULT_ANCHOR_EVERY_MS = 60_000;
const DEFAULT_KEY_ENV = "USERTRUST_ANCHOR_KEY";
const SNAPSHOT_RETRIES = 3;

// ── Identity ──

export interface AnchorIdentity {
	v: 1;
	vaultId: string;
	keyId: string;
	/** Informational cross-check ONLY — verifiers never take trust from the vault. */
	publicKeySpki: string;
	createdAt: string;
	/**
	 * Durable monotonic high-water of the highest anchorSeq ever minted. Lives
	 * OUTSIDE the mirror so an emptied/corrupt/lost mirror cannot trick the
	 * emitter into re-minting a lower (e.g. GENESIS-linked) anchorSeq — which
	 * would publish permanent fork evidence into the append-only store
	 * (spec §5.1). Absent on a fresh identity (first anchor allowed).
	 */
	lastAnchorSeq?: number;
	/**
	 * Every key this vault has ever anchored under, oldest first, INCLUDING the
	 * genesis key. `keyId`/`publicKeySpki` above are the current epoch; this is
	 * what lets a witness sink propose the key that actually signed a record
	 * when an old record is redelivered after a rotation. Absent on identities
	 * minted before key history existed — callers fall back to the current key.
	 */
	keyHistory?: { keyId: string; publicKeySpki: string }[];
}

/**
 * Atomic identity.json write: temp file + fsync + rename. A bare in-place
 * writeFileSync could be truncated by a crash mid-write, wedging the vault
 * between "no anchor identity" (emitter) and "identity already exists" (init).
 */
function writeIdentityFile(rootDir: string, identity: AnchorIdentity): void {
	const path = join(anchorsDir(rootDir), "identity.json");
	const tmp = `${path}.tmp-${process.pid}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, JSON.stringify(identity, null, "\t"));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** Persist the durable anchorSeq high-water (never decreases). */
function bumpAnchorHighWater(rootDir: string, anchorSeq: number): void {
	const identity = readAnchorIdentity(rootDir);
	if (identity === null) return;
	if ((identity.lastAnchorSeq ?? 0) >= anchorSeq) return;
	writeIdentityFile(rootDir, { ...identity, lastAnchorSeq: anchorSeq });
}

export function anchorsDir(rootDir: string): string {
	return join(rootDir, VAULT_DIR, "audit", "anchors");
}

export function readAnchorIdentity(rootDir: string): AnchorIdentity | null {
	const p = join(anchorsDir(rootDir), "identity.json");
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf-8")) as AnchorIdentity;
		if (parsed.v === 1 && typeof parsed.vaultId === "string" && typeof parsed.keyId === "string") {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export function defaultKeyPath(vaultId: string): string {
	return join(homedir(), ".usertrust", "keys", `${vaultId}.anchor.pem`);
}

/**
 * Resolve a path to its canonical absolute form, realpath-ing the deepest
 * EXISTING ancestor so symlinked parents (macOS /var → /private/var) compare
 * equal even when the leaf doesn't exist yet.
 */
function realResolve(p: string): string {
	const abs = resolve(p);
	let base = abs;
	const suffix: string[] = [];
	while (!existsSync(base)) {
		const parent = join(base, "..");
		if (parent === base) break;
		suffix.unshift(base.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
		base = parent;
	}
	try {
		base = realpathSync(base);
	} catch {
		/* keep the resolved form */
	}
	return suffix.length === 0 ? base : join(base, ...suffix);
}

/**
 * Mint the vault's anchor identity: Ed25519 keypair (private key OUTSIDE the
 * vault, mode 0600), `identity.json`, and an empty mirror file. Returns the
 * public PEM + keyId for out-of-band pinning. Idempotent: refuses to
 * overwrite an existing identity.
 */
export function initAnchorIdentity(
	rootDir: string,
	opts?: { keyFile?: string },
): { identity: AnchorIdentity; publicKeyPem: string; keyFile: string } {
	const dir = anchorsDir(rootDir);
	const identityPath = join(dir, "identity.json");
	if (existsSync(identityPath)) {
		throw new Error(`Anchor identity already exists: ${identityPath}`);
	}
	const vaultId = randomUUID();
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const keyId = keyIdFromKeyObject(publicKey);
	const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
	const publicKeySpki = (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString(
		"base64",
	);

	// Canonicalize BOTH sides before comparing: a relative --key-file (e.g.
	// ".usertrust/keys/anchor.pem") would never match an absolute prefix, and
	// symlinked temp dirs (macOS /var → /private/var) would defeat a plain
	// resolve() comparison — either way silently landing the signing key
	// inside the vault it vouches for (AC-6.2).
	const keyFile = realResolve(opts?.keyFile ?? defaultKeyPath(vaultId));
	const keyDir = join(keyFile, "..");
	const vaultAbs = realResolve(join(rootDir, VAULT_DIR));
	if (keyFile === vaultAbs || keyFile.startsWith(vaultAbs + sep)) {
		throw new Error("Refusing to write the anchor private key inside the vault (AC-6.2)");
	}
	mkdirSync(keyDir, { recursive: true, mode: 0o700 });
	writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
		mode: 0o600,
	});

	mkdirSync(join(dir, "outbox"), { recursive: true });
	const identity: AnchorIdentity = {
		v: 1,
		vaultId,
		keyId,
		publicKeySpki,
		createdAt: new Date().toISOString(),
		keyHistory: [{ keyId, publicKeySpki }],
	};
	writeIdentityFile(rootDir, identity);
	// Touch the mirror so "mirror file missing" (accidental loss / partial
	// restore) is distinguishable from "fresh vault, no anchors yet".
	const mirrorPath = join(dir, "anchors.jsonl");
	if (!existsSync(mirrorPath)) {
		writeFileSync(mirrorPath, "", { mode: 0o600 });
	}
	return { identity, publicKeyPem, keyFile };
}

// ── Signer resolution ──

interface ResolvedSigner {
	keyId: string;
	sign(preimageUtf8: string): Promise<string>;
}

export function resolveSigner(config: AnchorSignerConfig, vaultId?: string): ResolvedSigner {
	if (config.type === "external") {
		const pub = createPublicKey({
			key: Buffer.from(config.publicKeySpki, "base64"),
			format: "der",
			type: "spki",
		});
		const derivedKeyId = keyIdFromKeyObject(pub);
		if (derivedKeyId !== config.keyId) {
			throw new Error("external signer keyId does not match its publicKeySpki");
		}
		return {
			keyId: config.keyId,
			sign: async (preimage) =>
				Buffer.from(await config.sign(Buffer.from(preimage, "utf8"))).toString("base64"),
		};
	}
	let pem: string | undefined;
	const envName = config.env ?? DEFAULT_KEY_ENV;
	const envValue = process.env[envName];
	if (envValue !== undefined && envValue !== "") {
		pem = envValue.includes("-----BEGIN") ? envValue : readFileSync(envValue, "utf-8");
	} else if (config.file !== undefined) {
		pem = readFileSync(config.file, "utf-8");
	} else if (vaultId !== undefined && existsSync(defaultKeyPath(vaultId))) {
		pem = readFileSync(defaultKeyPath(vaultId), "utf-8");
	}
	if (pem === undefined) {
		throw new Error(
			`No anchor private key: set ${envName}, pass signer.file, or run \`usertrust anchor init\``,
		);
	}
	const privateKey = createPrivateKey(pem);
	// @types/node 26 dropped KeyObject from createPublicKey's input union; Node
	// derives the public key from a private KeyObject at runtime (documented) —
	// types-only assertion, runtime call unchanged.
	const publicKey = createPublicKey(privateKey as unknown as Parameters<typeof createPublicKey>[0]);
	return {
		keyId: keyIdFromKeyObject(publicKey),
		sign: async (preimage) =>
			cryptoSign(null, Buffer.from(preimage, "utf8"), privateKey).toString("base64"),
	};
}

// ── Sinks ──

function fileSink(path: string): AnchorSink {
	return {
		name: `file:${path}`,
		publish: async (record) => {
			const fd = openSync(path, "a", 0o600);
			try {
				writeSync(fd, `${canonicalize(record)}\n`);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
		},
	};
}

function httpsSink(url: string, headers?: Record<string, string>): AnchorSink {
	return {
		name: `https:${url}`,
		publish: (record) =>
			new Promise<void>((resolve, reject) => {
				import("node:https")
					.then((https) => {
						const body = Buffer.from(`${canonicalize(record)}\n`, "utf8");
						const req = https.request(
							url,
							{
								method: "POST",
								headers: {
									"content-type": "application/json",
									"content-length": String(body.length),
									...headers,
								},
								timeout: 15_000,
							},
							(res) => {
								res.resume();
								const code = res.statusCode ?? 0;
								if (code >= 200 && code < 300) {
									resolve();
								} else {
									reject(new Error(`anchor sink HTTP ${code}`));
								}
							},
						);
						req.on("timeout", () => req.destroy(new Error("anchor sink timeout")));
						req.on("error", reject);
						req.end(body);
					})
					.catch(reject);
			}),
	};
}

function commandSink(argv: string[]): AnchorSink {
	const [cmd, ...args] = argv;
	return {
		name: `command:${cmd ?? ""}`,
		publish: (record) =>
			new Promise<void>((resolve, reject) => {
				if (cmd === undefined) {
					reject(new Error("command sink: empty argv"));
					return;
				}
				const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
				let stderr = "";
				child.stderr.on("data", (d: Buffer) => {
					stderr += d.toString();
				});
				child.on("error", reject);
				child.on("close", (code) => {
					if (code === 0) {
						resolve();
					} else {
						reject(new Error(`command sink exited ${code}: ${stderr.slice(0, 300)}`));
					}
				});
				// A command that exits without reading stdin (crash, refusal)
				// races the write and emits EPIPE on the stdin stream — as an
				// UNHANDLED error unless listened for. The exit code above is
				// the verdict; the broken pipe is just its symptom.
				child.stdin.on("error", () => {
					/* verdict comes from the close handler's exit code */
				});
				child.stdin.end(`${canonicalize(record)}\n`);
			}),
	};
}

/**
 * `rootDir` is optional so existing callers keep working: only the Rekor sink
 * needs it, because inclusion receipts are persisted into the vault alongside
 * the mirror.
 */
export function createSink(config: SinkConfig | AnchorSink, rootDir?: string): AnchorSink {
	// Already an AnchorSink instance (custom/test sink) — pass through.
	if ("publish" in config && typeof config.publish === "function") {
		return config;
	}
	const cfg = config as SinkConfig;
	switch (cfg.type) {
		case "file":
			return fileSink(cfg.path);
		case "https":
			return httpsSink(cfg.url, cfg.headers);
		case "command":
			return commandSink(cfg.argv);
		case "s3":
			return s3Sink({
				bucket: cfg.bucket,
				region: cfg.region,
				...(cfg.prefix !== undefined ? { prefix: cfg.prefix } : {}),
				...(cfg.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
			});
		case "rekor":
			if (rootDir === undefined) {
				throw new Error("rekor sink requires rootDir");
			}
			return rekorSink(rootDir, cfg.url ?? DEFAULT_REKOR_URL);
	}
}

// ── Emitter advisory lock (anchor path only — never touches .audit-writer.lock) ──

/**
 * Lock paths currently held by a LIVE emitter in THIS process. A same-PID
 * lock file is only reclaimable when no live emitter here owns it (i.e. it
 * is a leftover from a crashed prior instance) — otherwise a sibling emitter
 * in the same process would steal a live lock and race the mirror (the
 * exact fork-evidence scenario the lock exists to prevent).
 */
const inProcessAnchorLocks = new Set<string>();

function tryAcquireAnchorLock(dir: string): (() => void) | null {
	const lockPath = join(dir, ".anchor-writer.lock");
	if (inProcessAnchorLocks.has(lockPath)) return null;
	const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
	const attempt = (): (() => void) | null => {
		try {
			const fd = openSync(
				lockPath,
				fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
				0o600,
			);
			try {
				writeSync(fd, content);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			inProcessAnchorLocks.add(lockPath);
			return () => {
				inProcessAnchorLocks.delete(lockPath);
				try {
					unlinkSync(lockPath);
				} catch {
					/* already removed */
				}
			};
		} catch {
			return null;
		}
	};
	const first = attempt();
	if (first !== null) return first;
	// Stale-lock detection: same liveness check as the audit writer lock.
	try {
		const existing = JSON.parse(readFileSync(lockPath, "utf-8")) as { pid?: number };
		if (typeof existing.pid === "number" && existing.pid !== process.pid) {
			try {
				process.kill(existing.pid, 0);
				return null; // live holder
			} catch (err: unknown) {
				if (
					!(err instanceof Error && "code" in err && (err as { code?: string }).code === "ESRCH")
				) {
					return null;
				}
			}
		} else if (typeof existing.pid === "number" && existing.pid === process.pid) {
			// Same-PID lock file with no live in-process owner (checked above):
			// leftover from a crashed prior emitter — safe to reclaim.
		} else {
			return null;
		}
	} catch {
		// Corrupt lock file — also reclaimed, but only via the atomic rename
		// below so a concurrent reclaimer cannot double-acquire.
	}
	// ATOMIC reclaim: exactly one contender wins the rename; the loser's
	// rename throws (ENOENT) and backs off. A bare check-then-unlink would let
	// a slow contender delete the winner's freshly created lock (TOCTOU) and
	// admit two emitters — the exact race the lock exists to prevent.
	try {
		const reclaimPath = `${lockPath}.reclaim-${process.pid}-${Date.now()}`;
		renameSync(lockPath, reclaimPath);
		unlinkSync(reclaimPath);
	} catch {
		return null;
	}
	return attempt();
}

// ── Mirror / outbox helpers ──

function readMirrorRecords(dir: string): {
	present: boolean;
	records: AnchorRecord[];
	errors: string[];
} {
	const mirrorPath = join(dir, "anchors.jsonl");
	if (!existsSync(mirrorPath)) return { present: false, records: [], errors: [] };
	try {
		const { records, errors } = parseAnchorsContent(readFileSync(mirrorPath, "utf-8"));
		return { present: true, records: records.sort((a, b) => a.anchorSeq - b.anchorSeq), errors };
	} catch (err) {
		return {
			present: true,
			records: [],
			errors: [`mirror unreadable: ${err instanceof Error ? err.message : String(err)}`],
		};
	}
}

/** Read pending outbox record CONTENTS in anchorSeq order (for redelivery). */
function pendingOutboxRecords(dir: string): AnchorRecord[] {
	return outboxSeqs(dir)
		.sort((a, b) => a - b)
		.flatMap((seq) => {
			try {
				const { record } = parseAnchorRecord(readFileSync(outboxPath(dir, seq), "utf-8").trim());
				return record !== null && record.anchorSeq === seq ? [record] : [];
			} catch {
				return [];
			}
		});
}

function outboxSeqs(dir: string): number[] {
	const outDir = join(dir, "outbox");
	if (!existsSync(outDir)) return [];
	try {
		return readdirSync(outDir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => Number.parseInt(f.slice(0, -5), 10))
			.filter((n) => Number.isSafeInteger(n) && n >= 1);
	} catch {
		return [];
	}
}

function outboxPath(dir: string, anchorSeq: number): string {
	return join(dir, "outbox", `${String(anchorSeq).padStart(12, "0")}.json`);
}

/** Fsync'd outbox write — the record's durable delivery intent. */
function writeOutboxEntry(dir: string, record: AnchorRecord): void {
	mkdirSync(join(dir, "outbox"), { recursive: true });
	const fd = openSync(outboxPath(dir, record.anchorSeq), "w", 0o600);
	try {
		writeSync(fd, canonicalize(record));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function readMeta(
	rootDir: string,
): { lastHash: string; sequence: number } | "absent" | "unreadable" {
	const metaPath = join(rootDir, VAULT_DIR, "audit", "events.jsonl.meta");
	if (!existsSync(metaPath)) return "absent";
	try {
		const raw = readFileSync(metaPath, "utf-8");
		if (raw.trim() === "") return "unreadable";
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.lastHash === "string" && typeof parsed.sequence === "number") {
			return { lastHash: parsed.lastHash, sequence: parsed.sequence };
		}
		return "unreadable";
	} catch {
		return "unreadable";
	}
}

// ── Emitter ──

export function createAnchorEmitter(rootDir: string, config: AnchoringConfig): AnchorEmitter {
	const vaultPath = join(rootDir, VAULT_DIR);
	const dir = anchorsDir(rootDir);
	const maybeIdentity = readAnchorIdentity(rootDir);
	if (maybeIdentity === null) {
		throw new Error("No anchor identity — run `usertrust anchor init` first");
	}
	// Non-null binding usable inside closures (control-flow narrowing of the
	// original is lost across the async emit() closure below).
	const identity: AnchorIdentity = maybeIdentity;
	const vaultId = identity.vaultId;
	const signer = resolveSigner(config.signer, vaultId);
	const sinks = (config.sinks ?? []).map((sink) => createSink(sink, rootDir));
	const retries = config.publishRetries ?? 5;

	let anchorSkips = 0;
	let publishFailures = 0;
	let degraded = false;
	let lastEmitError: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	const inFlight = new Set<Promise<void>>();

	/** Mirror append: the canonical bytes the record hash covers, fsync'd. */
	function appendToMirror(record: AnchorRecord): void {
		const fd = openSync(join(dir, "anchors.jsonl"), "a", 0o600);
		try {
			writeSync(fd, `${canonicalize(record)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
	// Serialize publish cycles so an overlapping cycle cannot interleave the
	// outbox drain and double-publish a record.
	let publishChain: Promise<void> = Promise.resolve();

	async function deliverToSinks(record: AnchorRecord): Promise<void> {
		let lastErr: unknown = null;
		for (const sink of sinks) {
			let delivered = false;
			for (let attempt = 0; attempt < retries && !delivered; attempt++) {
				try {
					await sink.publish(record);
					delivered = true;
				} catch (err) {
					lastErr = err;
					publishFailures++;
					const backoff = Math.min(30_000, 250 * 2 ** attempt) * (0.5 + Math.random());
					await new Promise((r) => setTimeout(r, backoff));
				}
			}
			if (!delivered) {
				degraded = true;
				throw lastErr instanceof Error
					? lastErr
					: new Error(`anchor publish failed to sink ${sink.name}`);
			}
		}
	}

	async function publishRecord(record: AnchorRecord): Promise<void> {
		if (sinks.length === 0) {
			// Pull mode (spec §5.5): mirror-only; a customer job ships records
			// via `usertrust anchor export`. With no sinks there is nothing to
			// deliver, so the outbox entry is not needed.
			try {
				unlinkSync(outboxPath(dir, record.anchorSeq));
			} catch {
				/* best effort */
			}
			return;
		}
		// Drain the backlog oldest-first BEFORE (and including) the current
		// record so a transient sink outage cannot leave a permanent
		// anchorSeq gap in the append-only store (spec §5.3). Stop on the
		// first failure to preserve store ordering; the emitter stays degraded
		// until the whole backlog clears.
		const backlog = pendingOutboxRecords(dir);
		const queue = backlog.some((r) => r.anchorSeq === record.anchorSeq)
			? backlog
			: [...backlog, record].sort((a, b) => a.anchorSeq - b.anchorSeq);
		for (const rec of queue) {
			await deliverToSinks(rec);
			try {
				unlinkSync(outboxPath(dir, rec.anchorSeq));
			} catch {
				/* best effort */
			}
		}
		// Clear degraded only when nothing is left undelivered.
		if (outboxSeqs(dir).length === 0) degraded = false;
	}

	function trackPublish(record: AnchorRecord): Promise<void> {
		const p = publishChain
			.then(() => publishRecord(record))
			.catch(() => {
				/* failure already counted; outbox entry retained for retry */
			})
			.finally(() => {
				inFlight.delete(p);
			});
		publishChain = p;
		inFlight.add(p);
		return p;
	}

	async function snapshotHead(): Promise<
		{ sequence: number; lastHash: string; hashes: string[] } | { skip: string }
	> {
		for (let attempt = 0; attempt < SNAPSHOT_RETRIES; attempt++) {
			const meta = readMeta(rootDir);
			if (meta === "unreadable") {
				// .meta is truncate-rewritten in place; a cross-process reader
				// can catch it mid-write. Retry, then skip the cycle.
				await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
				continue;
			}
			const hashes = gatherOrderedEventHashes(vaultPath);
			if (meta === "absent") {
				// Legacy vault: fall back to the ordered segment tail.
				if (hashes.length === 0) return { skip: "empty" };
				return {
					sequence: hashes.length,
					lastHash: hashes[hashes.length - 1] as string,
					hashes,
				};
			}
			if (meta.sequence === 0 || hashes.length === 0) return { skip: "empty" };
			// Guard against a torn read of the tail line during a concurrent
			// append: the prefix [0..sequence) is stable, the tail may not be.
			if (hashes.length >= meta.sequence && hashes[meta.sequence - 1] === meta.lastHash) {
				return { sequence: meta.sequence, lastHash: meta.lastHash, hashes };
			}
			await new Promise((r) => setTimeout(r, 25 * (attempt + 1)));
		}
		return { skip: "snapshot-unstable" };
	}

	async function emit(rotation?: {
		nextKeyId: string;
		nextPublicKeySpki: string;
	}): Promise<AnchorEmitResult> {
		const release = tryAcquireAnchorLock(dir);
		if (release === null) {
			anchorSkips++;
			return { emitted: false, reason: "locked" };
		}
		try {
			// Re-read identity fresh: the durable high-water is bumped on disk
			// each emit, so the creation-time closure copy is stale.
			const liveIdentity = readAnchorIdentity(rootDir) ?? identity;
			const snap = await snapshotHead();
			if ("skip" in snap) {
				if (snap.skip !== "empty") anchorSkips++;
				return { emitted: false, reason: snap.skip };
			}
			const mirror = readMirrorRecords(dir);
			if (!mirror.present) {
				// Mirror FILE missing while an identity exists: accidental loss
				// or partial restore. Refusing (loudly) beats silently minting a
				// second GENESIS-linked record — permanent fork evidence in an
				// append-only store. `usertrust anchor resume` re-seeds it.
				degraded = true;
				return { emitted: false, reason: "mirror-missing (run `usertrust anchor resume`)" };
			}
			if (mirror.errors.length > 0) {
				// Corrupt-but-present mirror: same accident class as
				// mirror-missing (disk fault / partial restore / torn tail). An
				// anchorSeq allocated from a partial view can re-occupy a
				// published position with divergent content — permanent fork
				// evidence (spec §5.1). Repair/move the mirror aside first.
				degraded = true;
				return {
					emitted: false,
					reason: "mirror-corrupt (repair the mirror, then `usertrust anchor resume`)",
				};
			}
			let tail = mirror.records.at(-1) ?? null;

			// Self-heal: a crash between the outbox write and the mirror append
			// leaves a fully minted record in the outbox that the mirror lacks.
			// Re-append it (validated: ours, signed by our key, contiguous)
			// instead of wedging or re-minting the seq — re-minting would
			// publish divergent content at an occupied position (permanent fork
			// evidence in the append-only store).
			for (const orphan of pendingOutboxRecords(dir).filter(
				(o) => o.anchorSeq > (mirror.records.at(-1)?.anchorSeq ?? 0),
			)) {
				const expectedPrev = tail === null ? GENESIS_HASH : anchorPayloadHash(tail);
				const idKey = publicKeyFromSpkiBase64(liveIdentity.publicKeySpki);
				const orphanOk =
					orphan.vaultId === vaultId &&
					orphan.anchorSeq === (tail?.anchorSeq ?? 0) + 1 &&
					orphan.prevAnchorHash === expectedPrev &&
					idKey !== null &&
					verifySignatureRaw("ed25519", anchorSigningPreimage(orphan), idKey, orphan.sig);
				if (!orphanOk) {
					degraded = true;
					return {
						emitted: false,
						reason:
							"outbox-orphan-invalid (inspect audit/anchors/outbox, then `usertrust anchor resume`)",
					};
				}
				appendToMirror(orphan);
				bumpAnchorHighWater(rootDir, orphan.anchorSeq);
				tail = orphan;
			}

			// Durable high-water lives outside the mirror: an emptied mirror
			// (tail null) with a prior anchor recorded must NOT restart at 1.
			const durableHighWater = liveIdentity.lastAnchorSeq ?? 0;
			const highWater = Math.max(tail?.anchorSeq ?? 0, durableHighWater, ...outboxSeqs(dir), 0);
			if ((tail?.anchorSeq ?? 0) < highWater) {
				degraded = true;
				return {
					emitted: false,
					reason: "mirror-behind-highwater (run `usertrust anchor resume`)",
				};
			}
			// Epoch guard: the resolved signer MUST be the chain's current key.
			// A superseded key (e.g. the pre-rotation PEM still at the default
			// path after `anchor rotate`) would mint permanent
			// rotation-continuity MISMATCH evidence in an append-only store.
			const expectedKeyId = tail?.rotation?.nextKeyId ?? tail?.keyId ?? liveIdentity.keyId;
			if (signer.keyId !== expectedKeyId) {
				degraded = true;
				return {
					emitted: false,
					reason: `stale-signer-key: signer ${signer.keyId} is not the current epoch key ${expectedKeyId} — point USERTRUST_ANCHOR_KEY/--key-file at the post-rotation private key`,
				};
			}
			// Vault-behind guard (symmetric to mirror-behind): an events head
			// BELOW the anchored treeSize means the event log was rolled back
			// (partial restore) — emitting would publish a decreasing-treeSize
			// anchor: permanent rollback evidence from an honest accident.
			if (tail !== null && snap.sequence < tail.treeSize) {
				degraded = true;
				return {
					emitted: false,
					reason: `vault-behind-anchors: events head ${snap.sequence} < anchored treeSize ${tail.treeSize} — restore the newer events before anchoring`,
				};
			}
			if (tail !== null && tail.treeSize === snap.sequence && rotation === undefined) {
				return { emitted: false, reason: "no-new-events" };
			}
			const tree = buildMerkleTree(snap.hashes.slice(0, snap.sequence));
			if (tree.root === undefined) {
				return { emitted: false, reason: "empty" };
			}
			const unsigned = {
				v: 1 as const,
				vaultId,
				anchorSeq: highWater + 1,
				prevAnchorHash: tail === null ? GENESIS_HASH : anchorPayloadHash(tail),
				treeSize: snap.sequence,
				lastHash: snap.lastHash,
				merkleRoot: tree.root,
				timestamp: new Date().toISOString(),
				keyId: signer.keyId,
				...(rotation !== undefined ? { rotation } : {}),
			};
			const sig = await signer.sign(canonicalize(unsigned));
			const record = { ...unsigned, sig } as AnchorRecord;
			const check = parseAnchorRecord(canonicalize(record));
			if (check.record === null) {
				throw new Error(`emitter produced an invalid record: ${check.error}`);
			}
			// Durability order: outbox FIRST (fsync'd delivery intent), then the
			// mirror append, then the high-water bump. A crash after only the
			// outbox write is self-healed above (orphan re-appended to the
			// mirror); the reverse order would strand a mirrored-but-never-
			// published record — a permanent anchor-chain gap in the store that
			// verifies as tampering.
			writeOutboxEntry(dir, record);
			appendToMirror(record);
			// High-water AFTER the mirror append is fsync'd, so a crash leaves
			// high-water ≤ mirror tail (never ahead of what exists).
			bumpAnchorHighWater(rootDir, record.anchorSeq);
			trackPublish(record);
			return { emitted: true, record };
		} finally {
			release();
		}
	}

	function status(): AnchorEmitterStatus {
		const mirror = readMirrorRecords(dir);
		const tail = mirror.records.at(-1) ?? null;
		const meta = readMeta(rootDir);
		const headSeq = typeof meta === "object" ? meta.sequence : null;
		const ts = tail === null ? Number.NaN : Date.parse(tail.timestamp);
		return {
			lastAnchor:
				tail === null
					? null
					: { anchorSeq: tail.anchorSeq, treeSize: tail.treeSize, timestamp: tail.timestamp },
			eventsSinceLastAnchor: headSeq === null ? 0 : Math.max(0, headSeq - (tail?.treeSize ?? 0)),
			msSinceLastAnchor: Number.isFinite(ts) ? Math.max(0, Date.now() - ts) : null,
			outboxDepth: outboxSeqs(dir).length,
			anchorSkips,
			publishFailures,
			degraded,
			lastEmitError,
		};
	}

	return {
		anchorNow: () => emit(),
		rotate: (next) => emit({ nextKeyId: next.keyId, nextPublicKeySpki: next.publicKeySpki }),
		status,
		start(): void {
			if (timer !== null) return;
			const everyMs = config.cadence?.everyMs ?? DEFAULT_ANCHOR_EVERY_MS;
			const everyEvents = config.cadence?.everyEvents ?? DEFAULT_ANCHOR_EVERY_EVENTS;
			let lastAnchorAt = Date.now();
			const tick = (): void => {
				const meta = readMeta(rootDir);
				const headSeq = typeof meta === "object" ? meta.sequence : 0;
				const mirror = readMirrorRecords(dir);
				const anchored = mirror.records.at(-1)?.treeSize ?? 0;
				const due =
					headSeq - anchored >= everyEvents ||
					(headSeq > anchored && Date.now() - lastAnchorAt >= everyMs);
				if (due) {
					lastAnchorAt = Date.now();
					// A scheduler-driven emit() must never reject into the void:
					// an unhandled rejection (KMS signer outage, ENOSPC on the
					// mirror, self-check throw) would crash the host process the
					// emitter is embedded in. Capture it as a loud, inspectable
					// degraded signal instead (spec §5.2/constraints §4.4).
					emit()
						.then((r) => {
							if (r.emitted) lastEmitError = null;
						})
						.catch((err: unknown) => {
							anchorSkips++;
							degraded = true;
							lastEmitError = err instanceof Error ? err.message : String(err);
						});
				}
			};
			// Check at a fraction of the interval so the everyEvents trigger
			// fires promptly; unref so the scheduler never holds the process.
			timer = setInterval(tick, Math.max(250, Math.min(everyMs, 5_000)));
			timer.unref?.();
		},
		async stop(): Promise<void> {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
			await Promise.allSettled([...inFlight]);
		},
		exportSince(since: number): AnchorRecord[] {
			return readMirrorRecords(dir).records.filter((r) => r.anchorSeq > since);
		},
	};
}

/**
 * Re-seed a lost mirror from the store's newest record (spec §5.1 step 4).
 * The record must belong to this vault's identity; it becomes the mirror
 * tail so the next emission allocates anchorSeq correctly instead of minting
 * a second GENESIS-linked chain.
 */
export function resumeAnchorMirror(rootDir: string, latestRecordRaw: string): AnchorRecord {
	const identity = readAnchorIdentity(rootDir);
	if (identity === null) {
		throw new Error("No anchor identity — run `usertrust anchor init` first");
	}
	const { record, error } = parseAnchorRecord(latestRecordRaw.trim());
	if (record === null) {
		throw new Error(`resume: supplied record is invalid: ${error}`);
	}
	if (record.vaultId !== identity.vaultId) {
		throw new Error(
			`resume: record vaultId ${record.vaultId} does not match this vault (${identity.vaultId})`,
		);
	}
	// The record becomes the trusted mirror tail (next emission links its
	// prevAnchorHash to it), so it MUST be provably ours: signed under the
	// CURRENT identity key, or a rotation handoff INTO the current key.
	// vaultId alone is public (printed by `anchor status`) — accepting any
	// well-formed record would let a stale/forged file seed a fork.
	const idKey = publicKeyFromSpkiBase64(identity.publicKeySpki);
	const sigOk =
		idKey !== null &&
		record.keyId === identity.keyId &&
		verifySignatureRaw("ed25519", anchorSigningPreimage(record), idKey, record.sig);
	// A rotation handoff is signed by the SUPERSEDED key, so it cannot verify
	// under the current epoch key. Authenticate it against the key that actually
	// signed it, looked up in this vault's own key history. The hole this closes
	// was an UNVERIFIED accept, not an unsigned field: the old code matched
	// `record.rotation.nextKeyId` against the current keyId and accepted the
	// record on that alone, never checking `record.sig` at all — so anyone who
	// knows the public vaultId (`anchor status` prints it) could self-sign a
	// record naming that keyId as its successor and seed a fork off it.
	// `rotation` IS covered by the signature — anchorSigningPreimage is
	// canonicalize(record − sig) — which is what stops the block from being
	// grafted onto a genuine record. Do not narrow that pre-image.
	let handoffOk = false;
	if (!sigOk && record.rotation !== undefined && record.rotation.nextKeyId === identity.keyId) {
		const signer = identity.keyHistory?.find((entry) => entry.keyId === record.keyId);
		const signerKey = signer === undefined ? null : publicKeyFromSpkiBase64(signer.publicKeySpki);
		handoffOk =
			signerKey !== null &&
			verifySignatureRaw("ed25519", anchorSigningPreimage(record), signerKey, record.sig);
	}
	if (!sigOk && !handoffOk) {
		throw new Error(
			"resume: record does not verify under this vault's current anchor key — fetch the STORE'S newest record",
		);
	}
	if ((identity.lastAnchorSeq ?? 0) > record.anchorSeq) {
		throw new Error(
			`resume: durable high-water ${identity.lastAnchorSeq} exceeds the supplied record (${record.anchorSeq}) — fetch the store's newest record`,
		);
	}
	const dir = anchorsDir(rootDir);
	const mirror = readMirrorRecords(dir);
	const tail = mirror.records.at(-1);
	if (tail !== undefined && tail.anchorSeq >= record.anchorSeq) {
		throw new Error(
			`resume: mirror already at anchorSeq ${tail.anchorSeq} (supplied ${record.anchorSeq})`,
		);
	}
	mkdirSync(dir, { recursive: true });
	const fd = openSync(join(dir, "anchors.jsonl"), "a", 0o600);
	try {
		writeSync(fd, `${canonicalize(record)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	// Re-seeding advances the durable high-water so the next emission allocates
	// from the re-seeded tail, not from a stale value.
	bumpAnchorHighWater(rootDir, record.anchorSeq);
	return record;
}

/**
 * Mint a successor keypair for `usertrust anchor rotate` (spec §6): the new
 * private key is written OUTSIDE the vault; the caller emits the cross-signed
 * rotation record via AnchorEmitter.rotate() and then updates identity.json.
 */
export function mintSuccessorKey(vaultId: string): {
	keyId: string;
	publicKeyPem: string;
	publicKeySpki: string;
	keyFile: string;
} {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const keyId = keyIdFromKeyObject(publicKey);
	const keyFile = join(homedir(), ".usertrust", "keys", `${vaultId}.anchor.${Date.now()}.pem`);
	mkdirSync(join(keyFile, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }) as string, {
		mode: 0o600,
	});
	return {
		keyId,
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
		publicKeySpki: (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
		keyFile,
	};
}

/**
 * Update identity.json after a successful rotation emission. The superseded key
 * is APPENDED to the history rather than replaced: records signed under it may
 * still be sitting in the outbox, and a witness sink must be able to name the
 * key that actually signed each one long after the epoch moved on.
 */
export function recordRotatedIdentity(
	rootDir: string,
	next: { keyId: string; publicKeySpki: string },
): void {
	const identity = readAnchorIdentity(rootDir);
	if (identity === null) {
		throw new Error("No anchor identity to rotate");
	}
	// An identity minted before key history seeds one from its current epoch, so
	// the pre-rotation key is not lost by upgrading mid-life.
	const history = identity.keyHistory ?? [
		{ keyId: identity.keyId, publicKeySpki: identity.publicKeySpki },
	];
	const updated: AnchorIdentity = {
		...identity,
		keyId: next.keyId,
		publicKeySpki: next.publicKeySpki,
		keyHistory: [...history.filter((entry) => entry.keyId !== next.keyId), next],
	};
	writeIdentityFile(rootDir, updated);
}
