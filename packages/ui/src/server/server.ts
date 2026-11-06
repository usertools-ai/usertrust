// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Loopback-only HTTP server over a usertrust vault. Read-only except
 * POST /api/export and PUT /api/settings; the vault itself is never written
 * (settings go to the workspace, outside it). Non-API routes serve the
 * prebuilt SPA. GET /api/tail
 * streams SSE: appended events are incrementally verified (linkage AND a
 * full hash recompute via usertrust-verify's canonicalize); any mismatch,
 * parse failure, file shrink, or a log replaced by another file triggers a
 * full reload + `resync` event.
 * Every state change bumps a version: each SSE frame carries it as its `id`,
 * and GET /api/events returns the version its snapshot was taken at, so the
 * client can re-apply frames newer than a snapshot that overtook them.
 *
 * Hardening (Amendment A3): every response carries
 * `X-Content-Type-Options: nosniff`; requests whose Host header is not the
 * bound loopback host:port are 403'd (DNS-rebinding guard); any request but
 * GET, HEAD or OPTIONS with a foreign Origin header is 403'd (CSRF guard);
 * a route answers 405 to a method it does not take, OPTIONS included, and no
 * response carries an access-control-* header, so a cross-origin preflight
 * always fails. PUT /api/settings also needs the per-start token from
 * GET /api/session in `x-usertrust-token`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EFFECTIVE_BUDGET_FILE,
	exportMarkdown,
	type PersistedAuditEvent,
	VAULT_DIR,
} from "usertrust";
import { canonicalize, verifyTransaction } from "usertrust-verify";
import { isHeaderSpend } from "../shared/aggregate.js";
import type { SettingKey, SettingsPayload } from "../shared/api.js";
import { type RowStatus, statusFor, toLedgerRows } from "../shared/rows.js";
import { hostAllowed, originAllowed, parseAllowHosts } from "./allow-host.js";
import {
	budgetSummary,
	type DeletionCause,
	type LedgerState,
	type LogHead,
	lastLineOfAppend,
	loadState,
	ROW_CAP,
	readAppended,
	readRemoteSettings,
} from "./state.js";

/** How often the budget files are polled for a change (`fs.watchFile`: a missing file is watched too). */
const BUDGET_POLL_MS = 1000;

import { serveStatic } from "./static.js";
import { watchLedger } from "./tail.js";
import {
	assertOutsideVault,
	isSettingKey,
	isSettingValue,
	SETTING_KEYS,
	Workspace,
	workspaceDir,
} from "./workspace.js";

/** How long close() lets in-flight requests finish before it cuts the connections still open. */
export const CLOSE_GRACE_MS = 400;

/** Amendment A5: maximum accepted /api/export request body, in bytes. */
const EXPORT_BODY_CAP = 64 * 1024;

/** Maximum accepted PUT /api/settings request body, in bytes. */
const SETTINGS_BODY_CAP = 4 * 1024;

/** The header every settings write carries the session token in. */
const TOKEN_HEADER = "x-usertrust-token";

/**
 * The methods each API route takes; any other method on it is a 405. A path under /api/ that is neither listed
 * here nor under /api/verify/ is a 404, so a route added below without a line here is never reached.
 */
const API_METHODS: ReadonlyMap<string, readonly string[]> = new Map([
	["/api/summary", ["GET"]],
	["/api/events", ["GET"]],
	["/api/tail", ["GET"]],
	["/api/export", ["POST"]],
	["/api/session", ["GET"]],
	["/api/settings", ["GET", "PUT"]],
]);

/** The methods `pathname` takes, or undefined when no route serves it (a 404). */
function methodsFor(pathname: string): readonly string[] | undefined {
	const listed = API_METHODS.get(pathname);
	if (listed !== undefined) return listed;
	if (pathname.startsWith("/api/verify/")) return ["GET"];
	if (pathname.startsWith("/api/")) return undefined;
	// Non-API routes: the prebuilt SPA.
	return ["GET", "HEAD"];
}

/** Whether `given` is the token, compared in constant time; a value of another length is simply wrong. */
function tokenMatches(given: string | string[] | undefined, token: string): boolean {
	if (typeof given !== "string") return false;
	const a = Buffer.from(given, "utf-8");
	const b = Buffer.from(token, "utf-8");
	return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Reads the request body up to `cap` bytes and hands it to `onBody` as text. Past the cap it answers 413 and
 * stops reading; `onBody` is then never called.
 */
function readBody(
	req: IncomingMessage,
	res: ServerResponse,
	cap: number,
	onBody: (raw: string) => void,
): void {
	const chunks: Buffer[] = [];
	let received = 0;
	let overCap = false;
	req.on("data", (chunk: Buffer) => {
		if (overCap) return;
		received += chunk.length;
		// Flush the 413 before destroying, so the client reliably sees the status.
		if (received > cap) {
			overCap = true;
			const payload = JSON.stringify({ error: "request body too large" });
			res.writeHead(413, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
			});
			res.end(payload, () => req.destroy());
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (overCap) return;
		onBody(Buffer.concat(chunks).toString("utf-8"));
	});
}

function isJson(req: IncomingMessage): boolean {
	const contentType = req.headers["content-type"];
	return contentType?.toLowerCase().startsWith("application/json") === true;
}

export interface UiServer {
	server: Server;
	port: number;
	/** The per-start token PUT /api/settings requires (32 random bytes, hex), as GET /api/session gives it. */
	token: string;
	close(): Promise<void>;
	reload(): void;
}

function sendJson(
	res: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders?: Record<string, string>,
): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

/**
 * A refusal sent before the request body is read. It closes the connection: a keep-alive socket whose last
 * request still has unread body bytes is not safe to reuse, and a client that reused it would see the next
 * request fail.
 */
function refuse(
	res: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders?: Record<string, string>,
): void {
	sendJson(res, status, body, { ...extraHeaders, connection: "close" });
}

export async function createUiServer(
	rootDir: string,
	opts?: {
		port?: number;
		appDir?: string;
		allowHosts?: readonly string[];
		/** Where settings are kept. Default `workspaceDir(rootDir)`; never inside the vault either way. */
		workspaceDir?: string;
	},
): Promise<UiServer> {
	const vaultPath = join(rootDir, VAULT_DIR);
	const token = randomBytes(32).toString("hex");
	// Settings are off, with this reason, when the workspace would sit inside the vault (a project rooted at the
	// home directory, whose vault is ~/.usertrust). The rest of the dashboard serves as before.
	let settingsDir: string | null = null;
	let settingsOff: string | null = null;
	try {
		const dir = opts?.workspaceDir ?? workspaceDir(rootDir);
		assertOutsideVault(rootDir, dir);
		settingsDir = dir;
	} catch (err) {
		settingsOff = err instanceof Error ? err.message : String(err);
	}
	/** Opened on the first settings request, so a server that never shows settings creates no directory. */
	let workspace: Workspace | undefined;
	function openWorkspace(): Workspace | null {
		if (settingsDir === null) return null;
		workspace ??= Workspace.open(settingsDir);
		return workspace;
	}
	function settingsPayload(): SettingsPayload {
		const ws = openWorkspace();
		const values = Object.fromEntries(
			SETTING_KEYS.map((k) => [k, ws === null ? null : ws.valueAt(k, null)]),
		) as Record<SettingKey, number | null>;
		if (ws === null) return { values, history: [], problem: settingsOff };
		const history = SETTING_KEYS.flatMap((k) => ws.history(k)).sort(
			(a, b) => Date.parse(a.at) - Date.parse(b.at),
		);
		return { values, history, problem: ws.problem };
	}
	// Extra Host names (`--allow-host`), validated again here so no caller can pass a wildcard in. The bind
	// below stays 127.0.0.1 whatever is allowed.
	const parsedHosts = parseAllowHosts(opts?.allowHosts ?? []);
	if (!parsedHosts.ok) throw new Error(parsedHosts.error);
	const allowHosts: readonly string[] = parsedHosts.names;
	// Compiled location is dist/server/ — the built SPA sits beside it in dist/app/.
	const appDir = opts?.appDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "app");
	let state: LedgerState = loadState(vaultPath);
	/**
	 * Whether this process has ever seen the vault's audit directory, listable or not. A resync that finds it gone
	 * after that is a deletion, not a first run (`loadState`'s `auditDirSeen`); a verified append proves it exists.
	 */
	let auditDirSeen = state.auditDirPresent;
	/**
	 * The audit directory's identity when this process first saw it (`loadState`'s `auditDirId`). A load, or a watcher
	 * check, that finds another directory at the path reads a deletion. Recorded once and never moved.
	 */
	let auditDirId = state.auditDirId;
	/**
	 * What a load of this process has detected as a deletion (the audit directory gone or replaced, the log missing
	 * events it held). Latched for the life of the process and passed to every later load: a directory recreated
	 * afterwards, holding a valid chain, does not clear it.
	 */
	let deletionSeen: DeletionCause[] = state.deletionCauses;
	/**
	 * What this process last verified (`LogHead`): its verified hash set by each full load that VERIFIED the vault (its
	 * read succeeded and its chain verified) and did not latch (or, while nothing is remembered yet, by the first whole
	 * read that did not latch, verified or not), and its `hadEvidence` by every whole read that did not latch, verified
	 * or not, once true staying true (`loadState`'s `head`); advanced to the last event of each verified append, but ONLY
	 * while the last full load verified. Every later full load must still hold it (`loadState`'s `head`). Without the append's
	 * advance, a truncation of events appended since the last full load would go unseen; with it after a load that did
	 * not verify, an append onto a chain that no full load verified (another chain renamed in while the read failed, or
	 * appended beside the verified one) would become the event the next load looks for.
	 */
	let head: LogHead | undefined = state.head;
	/**
	 * Whether the last full load read the whole vault (`loadState`'s `loadSucceeded`), set by every full load. While it
	 * is false, the watcher retries the read in full: at once on any change it sees, and otherwise at most every ten
	 * seconds (`watchLedger`), until a load succeeds again. A read that succeeded of a chain that does not verify is not
	 * retried on that schedule: reading it again changes nothing until the vault changes.
	 */
	let lastLoadSucceeded = state.loadSucceeded;
	/**
	 * Whether the last full load VERIFIED the vault (`loadState`'s `verified`): its read succeeded and its chain verified.
	 * While it is false, every grow is a full reload and the head moves only with a load that verifies.
	 */
	let lastLoadVerified = state.verified;
	/** When a full load last read the whole vault: the summary's `verifiedAt`, kept through loads that failed. */
	let verifiedAt = state.summary.verifiedAt;
	/** Whether a full load is running: the periodic re-verify is skipped then, never queued behind it. */
	let loading = false;
	let port = 0;

	const clients = new Set<ServerResponse>();
	/** The state's version: bumped on every change, sent as each frame's SSE `id` and with each snapshot. */
	let version = 0;

	function broadcast(eventName: string, data: unknown): void {
		const frame = `id: ${version}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
		for (const client of clients) client.write(frame);
	}

	function handleGrow(): void {
		// The incremental path only EXTENDS a verdict; it never derives one. A load that did not see a READABLE audit
		// directory (absent, or present and unlistable) raised its verdict from no log at all, and an append cannot clear
		// an alarm raised that way, nor see what only the vault's own checks see (a truncated tail still links from
		// genesis, so extending that state read as verified). So the first append after such a load is a full reload,
		// which re-derives the verdict from the whole log; once it finds the directory readable, appends are incremental
		// again. Readability decides only this; whether the directory was ever SEEN (`auditDirSeen`) is presence alone.
		// The same holds for a load that saw NO LOG BYTES (`byteOffset === 0`): a readable directory that held no log yet
		// (an empty one, one with only an anchor) gave a verdict with nothing to check, and a truncated log that arrives
		// later still links from genesis, so extending that state read as verified over a mismatched anchor. When the last
		// load saw no log bytes, a grow re-derives the verdict from the whole vault.
		// And after a full load that did not VERIFY (its read failed, or its chain did not verify), every grow is a full
		// reload until one verifies: an append is extended only onto a state a full load verified, never onto one whose
		// log was never read whole (another chain renamed in while the anchor could not be read, then appended to) or
		// whose chain is broken (another chain appended beside the verified one), either of which would otherwise become
		// the verified state.
		if (!lastLoadVerified || !state.auditDirReadable || state.byteOffset === 0) {
			handleResync();
			return;
		}
		// A load that saw a fragment after the log's last newline counted it as a malformed line. Whatever follows it (the
		// rest of an in-flight line, or a complete line after a dead writer's fragment) is re-derived by a full reload,
		// never extended onto a verdict that already counted the fragment.
		if (state.pendingFragment) {
			handleResync();
			return;
		}
		const logPath = join(vaultPath, "audit", "events.jsonl");
		try {
			// Only the bytes after the offset are read, through a descriptor whose identity is the one the last load
			// recorded. Another file at the path (a log replaced by rename, deleted and recreated), a log shorter than the
			// offset, or an identity that cannot be compared is a full reload: extending would append to a verdict derived
			// from a prefix this file may not hold. Before extending, the last line this state verified is re-read through
			// the same descriptor: an earlier event rewritten in place longer shifts every later byte and grows the log, and
			// the bytes after the offset are then the shifted tail, which holds no new line; only the moved last line shows
			// it. A same-inode rewrite that keeps the last line where it was (a same-length edit) is not seen here.
			const read = readAppended(logPath, state.byteOffset, state.logId, state.lastLine);
			if (read.kind !== "bytes" || read.lastLine === "changed") {
				handleResync();
				return;
			}
			const appended = read.buf;
			// Amendment A4: process only complete newline-terminated lines — hold
			// a partial tail back and let the next watch tick deliver the rest.
			const lastNewline = appended.lastIndexOf(0x0a);
			if (lastNewline === -1) return;
			const complete = appended.subarray(0, lastNewline + 1).toString("utf-8");
			const lines = complete.split("\n").filter((l) => l.trim());
			const fresh: PersistedAuditEvent[] = [];
			let lastHash = state.lastHash;
			for (const line of lines) {
				const e = JSON.parse(line) as PersistedAuditEvent;
				if (e.previousHash !== lastHash) throw new Error("linkage mismatch");
				// Amendment A4: linkage alone doesn't catch forged payloads —
				// recompute the hash exactly as usertrust-verify does.
				const { hash, ...rest } = e;
				const computed = createHash("sha256").update(canonicalize(rest)).digest("hex");
				if (computed !== hash) throw new Error("hash mismatch");
				fresh.push(e);
				lastHash = e.hash;
			}
			const touched = state.transfers.add(fresh);
			// A new record can change an EARLIER row's verdict (an ambiguity appended after an optimistic
			// settlement), so every visible row of a touched transfer is re-classified, and each change is sent.
			// Each change names its row by event HASH (unique on the chain); the id rides along for display only.
			const changed: Array<{ id: string; hash: string; status: RowStatus }> = [];
			for (const r of state.rows) {
				const key = state.transfers.keyOfRow(r.hash);
				if (key === undefined || !touched.has(key)) continue;
				const status = statusFor(
					r.kind,
					r.settled !== undefined ? { settled: r.settled } : {},
					state.transfers.verdictOfTransfer(key),
				);
				if (status !== r.status) {
					r.status = status;
					changed.push({ id: r.id, hash: r.hash, status });
				}
			}
			const rows = toLedgerRows(
				fresh,
				{ valid: true, breakIndex: null },
				state.transfers.verdictOf,
			);
			state.rows.push(...rows);
			state.lastHash = lastHash;
			state.lastLine = lastLineOfAppend(state.byteOffset, appended, lastNewline);
			state.byteOffset += lastNewline + 1;
			state.logTimes = read.times;
			for (const r of rows) {
				if (isHeaderSpend(r.kind, r.costUt)) state.summary.spentUt += r.costUt;
			}
			state.summary.remainingUt =
				state.summary.budget === null ? null : state.summary.budget - state.summary.spentUt;
			state.summary.chain.events += fresh.length;
			// The appended events were verified against the state the last full load verified (or this grow would have
			// been a full reload), so the last of them is now the event every later load must hold. `lastLoadVerified` is
			// already guaranteed by the early return above; it is checked again here as defence in depth, so a change to
			// that return cannot let an append onto an unverified state move the head.
			if (lastLoadVerified && fresh.length > 0)
				head = { verifiedHash: lastHash, hadEvidence: true };
			auditDirSeen = true;
			// A verified append is the first activity of a vault that had none.
			if (fresh.length > 0) state.summary.chain.empty = false;
			// Amendment A4: enforce ROW_CAP after append.
			if (state.rows.length > ROW_CAP) {
				state.rows.splice(0, state.rows.length - ROW_CAP);
				state.summary.truncated = true;
			}
			state.summary.rowCount = state.rows.length;
			version += 1;
			if (changed.length > 0) broadcast("status", changed);
			broadcast("rows", rows);
			broadcast("summary", state.summary);
		} catch {
			handleResync();
		}
	}

	function handleResync(): void {
		loading = true;
		try {
			state = loadState(vaultPath, ROW_CAP, auditDirSeen, deletionSeen, auditDirId, head);
		} finally {
			loading = false;
		}
		auditDirSeen ||= state.auditDirPresent;
		auditDirId ??= state.auditDirId;
		deletionSeen = state.deletionCauses;
		// A load that failed or latched keeps the head it was judged against (`state.head` is then undefined). One that
		// did not verify returns the verified hash it was judged against, with any evidence it saw added.
		head = state.head ?? head;
		lastLoadSucceeded = state.loadSucceeded;
		lastLoadVerified = state.verified;
		if (state.loadSucceeded) verifiedAt = state.summary.verifiedAt;
		else state.summary.verifiedAt = verifiedAt;
		version += 1;
		broadcast("resync", {});
		broadcast("summary", state.summary);
	}

	/** Set first thing in close(). Once true, a request that starts during the grace is refused. */
	let closing = false;
	/** Responses not yet finished, so close() can stop their sockets being reused. */
	const inFlight = new Set<ServerResponse>();

	const handler = (req: IncomingMessage, res: ServerResponse): void => {
		// Amendment A3: on every response, including errors. First, so no early return can skip it.
		res.setHeader("x-content-type-options", "nosniff");

		// A keep-alive client can send a new request on a socket that was busy when close() was called, and
		// the grace would let it run (an export writing files after close(), a tail client re-registering).
		if (closing) {
			sendJson(res, 503, { error: "server closing" }, { connection: "close" });
			return;
		}
		inFlight.add(res);
		res.once("close", () => inFlight.delete(res));

		// Amendment A3: DNS-rebinding guard — only loopback Host headers.
		const host = req.headers.host;
		if (
			host !== `127.0.0.1:${port}` &&
			host !== `localhost:${port}` &&
			!hostAllowed(host, allowHosts, port)
		) {
			refuse(res, 403, { error: "forbidden host" });
			return;
		}

		// Amendment A3: CSRF guard — reject any request that can change something (every method but GET, HEAD and
		// OPTIONS, so a method added later is covered too) carrying a foreign Origin.
		if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
			const origin = req.headers.origin;
			if (
				origin !== undefined &&
				origin !== `http://127.0.0.1:${port}` &&
				origin !== `http://localhost:${port}` &&
				!originAllowed(origin, allowHosts, port)
			) {
				refuse(res, 403, { error: "forbidden origin" });
				return;
			}
		}

		// Node accepts an absolute-form request target (RFC 9112 §3.2.2) and hands
		// it to the handler verbatim in `req.url`, so a client controls the whole
		// string `new URL` parses — `GET http://foo:999999/`, `http://%/`,
		// `http://[::1/` all throw here. Unguarded, that throw escapes the handler
		// with no response written: the connection hangs and, since nothing in
		// `packages/ui` installs an `uncaughtException` handler, the process dies.
		// The Host guard above does not cover this — the Host *header* is
		// independent of the request *target*, and a real loopback Host walks
		// straight through it. This runs before every route, so it is the only
		// place the whole surface can be closed at once.
		let url: URL;
		try {
			url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		} catch {
			sendJson(res, 400, { error: "malformed request target" });
			return;
		}
		// Each route takes only its listed methods (`API_METHODS`); the routes below rely on this.
		const methods = methodsFor(url.pathname);
		if (methods === undefined) {
			sendJson(res, 404, { error: "not found" });
			return;
		}
		if (!methods.includes(req.method ?? "")) {
			refuse(res, 405, { error: "method not allowed" }, { allow: methods.join(", ") });
			return;
		}
		if (url.pathname === "/api/summary") {
			sendJson(res, 200, state.summary);
			return;
		}
		if (url.pathname === "/api/events") {
			sendJson(res, 200, { rows: state.rows, summary: state.summary, version });
			return;
		}
		if (url.pathname === "/api/session") {
			// Same-origin only by construction: no access-control-* header is ever sent, and the Host guard above
			// keeps a rebound name from reading it.
			sendJson(res, 200, { token }, { "cache-control": "no-store" });
			return;
		}
		if (url.pathname === "/api/settings" && req.method === "GET") {
			sendJson(res, 200, settingsPayload(), { "cache-control": "no-store" });
			return;
		}
		if (url.pathname === "/api/settings") {
			// PUT. The token is checked before anything is read, so a request without it learns nothing.
			if (!tokenMatches(req.headers[TOKEN_HEADER], token)) {
				refuse(res, 403, { error: "missing or wrong token" });
				return;
			}
			if (!isJson(req)) {
				refuse(res, 415, { error: "content-type must be application/json" });
				return;
			}
			readBody(req, res, SETTINGS_BODY_CAP, (raw) => {
				let body: unknown;
				try {
					body = JSON.parse(raw);
				} catch {
					sendJson(res, 400, { error: "body must be JSON" });
					return;
				}
				// Exactly { key, value }: any other field (a client-supplied `at` among them) is refused, so an entry
				// is always dated by this server, now, and nothing can be backdated.
				if (
					typeof body !== "object" ||
					body === null ||
					Array.isArray(body) ||
					Object.keys(body).length !== 2 ||
					!Object.hasOwn(body, "key") ||
					!Object.hasOwn(body, "value")
				) {
					sendJson(res, 400, { error: "body must be exactly { key, value }" });
					return;
				}
				const { key, value } = body as Record<string, unknown>;
				if (!isSettingKey(key)) {
					sendJson(res, 400, { error: `unknown setting: ${String(key)}` });
					return;
				}
				if (!isSettingValue(value)) {
					sendJson(res, 400, { error: `${key} needs a finite number >= 0, or null` });
					return;
				}
				const ws = openWorkspace();
				if (ws === null) {
					sendJson(res, 409, { error: settingsOff });
					return;
				}
				try {
					ws.append(key, value);
				} catch (err) {
					// The workspace refused the write (unsafe, or the file could not be written); nothing was saved.
					sendJson(res, 409, { error: err instanceof Error ? err.message : String(err) });
					return;
				}
				sendJson(res, 200, settingsPayload(), { "cache-control": "no-store" });
			});
			return;
		}
		if (url.pathname === "/api/tail") {
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.write(": connected\n\n");
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}
		if (url.pathname === "/api/export") {
			// Amendment A5: JSON bodies only.
			if (!isJson(req)) {
				refuse(res, 415, { error: "content-type must be application/json" });
				return;
			}
			// Amendment A5: cap the request body.
			readBody(req, res, EXPORT_BODY_CAP, (raw) => {
				try {
					const body = JSON.parse(raw || "{}") as { outDir?: string };
					if (typeof body.outDir !== "string" || body.outDir.length === 0) {
						sendJson(res, 400, { error: "outDir required" });
						return;
					}
					const outDir = resolve(rootDir, body.outDir);
					// Amendment A5: containment — the resolved outDir must stay
					// inside the project root and out of the vault interior.
					const rootResolved = resolve(rootDir);
					const vaultResolved = resolve(vaultPath);
					const insideRoot = outDir === rootResolved || outDir.startsWith(rootResolved + sep);
					// Vault exclusion compares case-insensitively: on case-insensitive
					// filesystems (darwin/win32) ".USERTRUST" IS the vault. Folding only
					// the deny-side check widens the deny set, never the allow set.
					const outFolded = outDir.toLowerCase();
					const vaultFolded = vaultResolved.toLowerCase();
					const insideVault = outFolded === vaultFolded || outFolded.startsWith(vaultFolded + sep);
					if (!insideRoot || insideVault) {
						sendJson(res, 400, {
							error: "outDir must resolve inside the project root, outside the vault",
						});
						return;
					}
					sendJson(res, 200, exportMarkdown(vaultPath, outDir));
				} catch (err) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			});
			return;
		}
		if (url.pathname.startsWith("/api/verify/")) {
			// `decodeURIComponent` throws URIError on malformed percent-encoding
			// (`%`, `%zz`, `%E0%A4%A`). `new URL` does NOT reject those — it carries
			// an invalid escape through to `pathname` untouched — so the guard above
			// cannot stand in for this one, and this one cannot stand in for that:
			// they cover disjoint inputs and both are required. Unwrapped inside a
			// request handler, this throw escapes to the top level and terminates the
			// usertrust-ui process. The catch stays around this call alone:
			// `verifyTransaction` reports found/valid through its result object rather
			// than by throwing for a transaction, so widening this catch would relabel a genuine server
			// fault (an unreadable vault) as a client 400; the unreadable-segment throw is caught below as a 500.
			let txId: string;
			try {
				txId = decodeURIComponent(url.pathname.slice("/api/verify/".length));
			} catch {
				sendJson(res, 400, { error: "malformed percent-encoding in transaction id" });
				return;
			}
			// An audit segment that cannot be read makes `verifyTransaction` THROW (it will not turn unread records
			// into "not found"). That is a server fault, not a client error: 500, with a fixed message (the thrown
			// text carries the vault's file names), and the process keeps serving.
			let result: ReturnType<typeof verifyTransaction>;
			try {
				result = verifyTransaction(vaultPath, txId);
			} catch {
				sendJson(res, 500, { error: "audit log could not be read" });
				return;
			}
			sendJson(res, result.found ? 200 : 404, result);
			return;
		}
		if (url.pathname.startsWith("/api/")) {
			// A path listed in API_METHODS with no branch above.
			sendJson(res, 404, { error: "not found" });
			return;
		}
		// Non-API routes: the prebuilt SPA, with index.html fallback for client routing.
		serveStatic(appDir, url.pathname, res);
	};

	const server = createServer(handler);
	await new Promise<void>((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(opts?.port ?? 4180, "127.0.0.1", () => resolvePromise());
	});
	const address = server.address();
	port = typeof address === "object" && address !== null ? address.port : 0;

	// Watch only once the bind succeeded — a failed bind must not leak an
	// fs.watch handle (createUiServer throws and close() is never reachable).
	const stopWatching = watchLedger(
		vaultPath,
		() => state.byteOffset,
		{
			onGrow: handleGrow,
			onResync: handleResync,
			// The same full load, on a schedule; skipped while one is running.
			onReverify: () => {
				if (!loading) handleResync();
			},
		},
		() => state.logId,
		() => auditDirId,
		() => state.logTimes,
		() => !lastLoadSucceeded,
		() => state.anchorStamp,
	);
	// The budget's two sources live OUTSIDE `audit/`, which watchLedger watches: a governor writes its record when it
	// starts, and an operator edits the config. Each change re-reads the budget, and the config's `remote` section, and
	// sends the summary: turning the kit mark on or off takes effect without a restart.
	const budgetFiles = [
		join(vaultPath, EFFECTIVE_BUDGET_FILE),
		join(vaultPath, "usertrust.config.json"),
	];
	const refreshBudget = (): void => {
		const next = budgetSummary(vaultPath, state.summary.spentUt);
		const remote = readRemoteSettings(vaultPath);
		if (
			next.budget === state.summary.budget &&
			next.budgetSource === state.summary.budgetSource &&
			next.budgetWrittenAt === state.summary.budgetWrittenAt &&
			// the provenance carries an unreadable record's REASON, which can change while the rest does not
			next.budgetProvenance === state.summary.budgetProvenance &&
			remote.kit === state.summary.remote.kit
		)
			return;
		Object.assign(state.summary, next, { remote });
		// A state change like any other: a new version, so a snapshot taken before it is not mistaken for one after.
		version += 1;
		broadcast("summary", state.summary);
	};
	for (const f of budgetFiles) watchFile(f, { interval: BUDGET_POLL_MS }, refreshBudget);

	return {
		server,
		port,
		token,
		// A reload is a resync: a new version, and every client told to fetch the new snapshot.
		reload(): void {
			handleResync();
		},
		close(): Promise<void> {
			closing = true;
			// A response whose headers are not written yet carries Connection: close, so its socket is not
			// reused for another request during the grace.
			for (const res of inFlight) if (!res.headersSent) res.shouldKeepAlive = false;
			stopWatching();
			for (const f of budgetFiles) unwatchFile(f, refreshBudget);
			for (const c of clients) c.end();
			clients.clear();
			// In-flight requests get the grace to finish; anything still open after it is closed, so a held
			// connection can't hold close() for seconds. The timer is cleared once every connection has ended
			// on its own, and unref'd so it never keeps the process alive.
			let cutTimer: NodeJS.Timeout | undefined;
			const closed = new Promise<void>((resolvePromise) =>
				server.close(() => {
					if (cutTimer !== undefined) clearTimeout(cutTimer);
					resolvePromise();
				}),
			);
			cutTimer = setTimeout(() => server.closeAllConnections(), CLOSE_GRACE_MS);
			cutTimer.unref();
			return closed;
		},
	};
}
