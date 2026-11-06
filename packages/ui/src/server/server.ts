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
 * GET /api/at answers the vault as recorded at a past position (`AtPayload`).
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync, statSync, unwatchFile, watchFile } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	EFFECTIVE_BUDGET_FILE,
	exportMarkdown,
	type PersistedAuditEvent,
	VAULT_DIR,
} from "usertrust";
import { type TransferStatus, verifyTransaction } from "usertrust-verify";
import { isHeaderSpend } from "../shared/aggregate.js";
import type { AtPayload, SettingKey, SettingsPayload } from "../shared/api.js";
import { type RowStatus, statusFor, toLedgerRows } from "../shared/rows.js";
import { hostAllowed, originAllowed, parseAllowHosts } from "./allow-host.js";
import { parseZonedTime } from "./position-index.js";
import {
	budgetSummary,
	contentHash,
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
	assertOutsideProject,
	canonical,
	isSettingKey,
	isSettingValue,
	SETTING_KEYS,
	Workspace,
	WorkspaceRefusal,
	workspaceDir,
} from "./workspace.js";

/** How long close() lets in-flight requests finish before it cuts the connections still open. */
export const CLOSE_GRACE_MS = 400;

/** Amendment A5: maximum accepted /api/export request body, in bytes. */
const EXPORT_BODY_CAP = 64 * 1024;

/** Maximum accepted PUT /api/settings request body, in bytes. */
const SETTINGS_BODY_CAP = 4 * 1024;

/** The answer when the settings log cannot be read. */
const SETTINGS_UNREADABLE = "settings could not be read";

/** What `AtPayload.budget.note` says until the vault records budget changes: the budget shown is today's. */
const BUDGET_NOTE = "budget history starts with the first budget record; this is today's budget";

/** A position as a query gives it: digits only (no sign, no exponent, no fraction, no spaces). */
const POSITION = /^\d+$/;

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
	["/api/at", ["GET"]],
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

/** How much of an over-cap body is read and dropped before the 413; past this the connection is cut. */
const DRAIN_CAP = 1024 * 1024;

/**
 * Reads the request body up to `cap` bytes and hands it to `onBody` as text. Past the cap nothing more is kept and
 * `onBody` is never called: the rest is read and dropped, and the 413 is sent once the body ends, with the
 * connection closed. Closing with body bytes still unread would make the close a reset, which can reach the
 * client before it has read the 413. A body more than DRAIN_CAP past the cap gets the 413 at once and the socket
 * is cut.
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
	let cut = false;
	const tooLarge = { error: "request body too large" };
	req.on("data", (chunk: Buffer) => {
		if (cut) return;
		received += chunk.length;
		if (received > cap + DRAIN_CAP) {
			cut = true;
			// Flush the 413 before destroying, so the client has the best chance to see the status.
			const payload = JSON.stringify(tooLarge);
			res.writeHead(413, {
				"content-type": "application/json",
				"content-length": Buffer.byteLength(payload),
				connection: "close",
			});
			res.end(payload, () => req.destroy());
			return;
		}
		if (received > cap) {
			overCap = true;
			chunks.length = 0;
			return;
		}
		chunks.push(chunk);
	});
	req.on("end", () => {
		if (cut) return;
		if (overCap) {
			refuse(res, 413, tooLarge);
			return;
		}
		onBody(Buffer.concat(chunks).toString("utf-8"));
	});
}

function isJson(req: IncomingMessage): boolean {
	const contentType = req.headers["content-type"];
	return contentType?.toLowerCase().startsWith("application/json") === true;
}

/**
 * The 400 for a key that is not a setting. Only a string is quoted, cut to 64 characters; anything else gets a
 * fixed message, since turning an arbitrary JSON value into text can throw (`{"toString":null}`).
 */
function unknownKeyMessage(key: unknown): string {
	if (typeof key !== "string") return "unknown setting key";
	const shown = key.length > 64 ? `${key.slice(0, 64)}…` : key;
	return `unknown setting: ${JSON.stringify(shown)}`;
}

export interface UiServer {
	server: Server;
	port: number;
	/** The per-start token PUT /api/settings requires (32 random bytes, hex), as GET /api/session gives it. */
	token: string;
	/** The project root this server reads, as the OS opens it (`resolveProjectRoot`). */
	root: string;
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

/**
 * The project root as the OS opens it: the argument resolved once, with `realpathSync.native`, and used for
 * everything after. `path.join`/`resolve` and the JS `realpathSync` collapse `..` lexically, but the OS applies
 * `..` after following the link before it, so `work/link/..` (`link -> other/sub`) is `other`, not `work`. A root
 * that cannot be resolved, or is not a directory, is a start error that names it; it is never taken as written.
 */
export function resolveProjectRoot(rootDir: string): string {
	let root: string;
	try {
		root = realpathSync.native(rootDir);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code ?? "error";
		throw new Error(`the project root ${JSON.stringify(rootDir)} cannot be opened (${code})`);
	}
	if (!statSync(root).isDirectory()) {
		throw new Error(`the project root ${JSON.stringify(root)} is not a directory`);
	}
	return root;
}

export async function createUiServer(
	rootDir: string,
	opts?: {
		port?: number;
		appDir?: string;
		allowHosts?: readonly string[];
		/** Where settings are kept. Default `workspaceDir(<the resolved root>)`; never inside the project or its vault. */
		workspaceDir?: string;
		/** How many rows are held and served (the latest ones). Default `ROW_CAP`. */
		rowCap?: number;
	},
): Promise<UiServer> {
	// One root for the whole server: the vault it shows and reads, the export guard and the settings checks.
	const root = resolveProjectRoot(rootDir);
	const vaultPath = join(root, VAULT_DIR);
	const token = randomBytes(32).toString("hex");
	// Settings are off, with this reason, when the workspace would sit inside the project or its vault (by
	// default, a project rooted at or above the home directory). The rest of the dashboard serves as before.
	let settingsDir: string | null = null;
	let settingsOff: string | null = null;
	try {
		const dir = opts?.workspaceDir ?? workspaceDir(root);
		assertOutsideProject(root, dir);
		settingsDir = dir;
	} catch (err) {
		settingsOff = err instanceof Error ? err.message : String(err);
	}
	/** Opened on the first settings request. Opening reads only: the first write creates the directory. */
	let workspace: Workspace | undefined;
	/**
	 * The workspace, or why settings are off. Containment is checked again on every call, not only at start: the
	 * project's vault can be moved or relinked while the server runs, and a workspace that has come to sit inside
	 * it is then neither read nor written.
	 */
	function openWorkspace(): Workspace | string {
		if (settingsDir === null) return settingsOff ?? "settings are off";
		try {
			assertOutsideProject(root, settingsDir);
		} catch (err) {
			return err instanceof Error ? err.message : String(err);
		}
		workspace ??= Workspace.open(settingsDir, root);
		return workspace;
	}
	/**
	 * Answers with the settings. A read of the log can throw (an I/O error, the file replaced mid-read): that is a
	 * 500 with a fixed message, never a throw out of the handler, which would end the process.
	 */
	function sendSettings(res: ServerResponse): void {
		let payload: SettingsPayload;
		try {
			payload = settingsPayload();
		} catch {
			sendJson(res, 500, { error: SETTINGS_UNREADABLE });
			return;
		}
		sendJson(res, 200, payload, { "cache-control": "no-store" });
	}
	function settingsPayload(): SettingsPayload {
		const ws = openWorkspace();
		const values = Object.fromEntries(
			SETTING_KEYS.map((k) => [k, typeof ws === "string" ? null : ws.valueAt(k, null)]),
		) as Record<SettingKey, number | null>;
		if (typeof ws === "string") return { values, history: [], problem: ws };
		const history = SETTING_KEYS.flatMap((k) => ws.history(k)).sort(
			(a, b) => Date.parse(a.at) - Date.parse(b.at),
		);
		return { values, history, problem: ws.problem };
	}
	/** PUT /api/settings, once the token, content type and size have passed: `raw` is the body. */
	function putSetting(res: ServerResponse, raw: string): void {
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
			sendJson(res, 400, { error: unknownKeyMessage(key) });
			return;
		}
		if (!isSettingValue(value)) {
			sendJson(res, 400, { error: `${key} needs a finite number >= 0, or null` });
			return;
		}
		let ws: Workspace | string;
		try {
			ws = openWorkspace();
		} catch {
			sendJson(res, 500, { error: SETTINGS_UNREADABLE });
			return;
		}
		if (typeof ws === "string") {
			sendJson(res, 409, { error: ws });
			return;
		}
		try {
			ws.append(key, value);
		} catch (err) {
			// A safety refusal is the workspace's answer (409, with its reason); anything else is an I/O
			// failure (a full disk, a permission error) and a server fault, with a fixed message.
			if (err instanceof WorkspaceRefusal) sendJson(res, 409, { error: err.message });
			else sendJson(res, 500, { error: "settings could not be saved" });
			return;
		}
		sendSettings(res);
	}
	// Extra Host names (`--allow-host`), validated again here so no caller can pass a wildcard in. The bind
	// below stays 127.0.0.1 whatever is allowed.
	const parsedHosts = parseAllowHosts(opts?.allowHosts ?? []);
	if (!parsedHosts.ok) throw new Error(parsedHosts.error);
	const allowHosts: readonly string[] = parsedHosts.names;
	// Compiled location is dist/server/ — the built SPA sits beside it in dist/app/.
	const appDir = opts?.appDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "app");
	const rowCap = opts?.rowCap ?? ROW_CAP;
	if (!Number.isSafeInteger(rowCap) || rowCap < 1)
		throw new Error("rowCap must be a whole number >= 1");
	let state: LedgerState = loadState(vaultPath, rowCap);
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
	/**
	 * Bumped by a full reload (`handleResync`) that yields other records than the state it replaces: another log
	 * (`logId`), another number of events, another tip (`lastHash`), another break index (`fullBreakIndex`), or another
	 * records digest (`LedgerState.records`: any record whose recomputed content or stored hash differs, or sits
	 * elsewhere, such as a record rewritten in place after an existing break with every stored hash, the tip, the count
	 * and the break kept). A position can then name another record (a log replaced, truncated, rotated) or one that
	 * reads otherwise. Never by an append (which extends the digest), and never by a reload of an unchanged vault (the
	 * periodic re-verify), which would read to the page as a reload every few minutes. `AtPayload.epoch` carries it.
	 */
	let epoch = 0;

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
			// Each appended record's recomputed content hash, for the state's records digest once every line verified.
			const freshContent: string[] = [];
			let lastHash = state.lastHash;
			let lastSequence = state.lastSequence;
			for (const line of lines) {
				const e = JSON.parse(line) as PersistedAuditEvent;
				if (e.previousHash !== lastHash) throw new Error("linkage mismatch");
				// A vault ordered by `sequence` stays in that order only if each append's sequence is above the last: the
				// next full read would sort a lower one earlier, which moves positions and can break the chain. Reload.
				if (lastSequence !== null) {
					if (typeof e.sequence !== "number" || !(e.sequence > lastSequence))
						throw new Error("sequence out of order");
					lastSequence = e.sequence;
				}
				// Amendment A4: linkage alone doesn't catch forged payloads —
				// recompute the hash exactly as usertrust-verify does.
				const computed = contentHash(e);
				if (computed !== e.hash) throw new Error("hash mismatch");
				fresh.push(e);
				freshContent.push(computed);
				lastHash = e.hash;
			}
			// Every appended event was verified onto the chain the last full load verified, so each takes the next position.
			const firstPos = state.positions.length;
			const touched = state.transfers.add(fresh, firstPos);
			for (const e of fresh) state.positions.add(e);
			for (const [i, e] of fresh.entries()) state.records.add(freshContent[i] as string, e.hash);
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
				firstPos,
			);
			state.rows.push(...rows);
			state.lastHash = lastHash;
			state.lastSequence = lastSequence;
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
			// Amendment A4: enforce the row cap after append.
			if (state.rows.length > rowCap) {
				state.rows.splice(0, state.rows.length - rowCap);
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
		const before = state;
		loading = true;
		try {
			state = loadState(vaultPath, rowCap, auditDirSeen, deletionSeen, auditDirId, head);
		} finally {
			loading = false;
		}
		if (
			state.logId !== before.logId ||
			state.positions.length !== before.positions.length ||
			state.lastHash !== before.lastHash ||
			state.fullBreakIndex !== before.fullBreakIndex ||
			state.records.value() !== before.records.value()
		)
			epoch += 1;
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

	/**
	 * GET /api/at: the vault as recorded at one position, from `?pos=N` or `?t=<ISO>` (exactly one). Every figure is
	 * read from prefix sums kept over the whole vault (`PositionIndex`) and the transfer index, never by a pass over
	 * the events; only the rows whose status at the position can differ from now are classified again.
	 *
	 * - `pos`: digits only. Past the head, it is the head, with `clamped: true`.
	 * - `t`: an ISO-8601 date and time with `Z` or an offset (`parseZonedTime`; a `+` must be sent as `%2B`), compared
	 *   in epoch ms. It answers the last position whose events are all at or before `t` (`positionAt`). A `t` before
	 *   the first record is a 404 `{ error: "no records before this time" }`. "The first record" is the first whose time
	 *   PARSES: when the first record's time does not parse, `positionAt` answers it for any `t` (its running maximum
	 *   is -Infinity), so the 404 is judged against the first time that does. Such records stay reachable by `pos`.
	 * - `counts`: `llm_call` records (an `llm_call_failed` is not one: it counts as `other`), denials (`policy_denied`
	 *   and `ledger_rejected`), and every other record, at positions `0..pos`. `spentUt` is the header's Spend rule.
	 * - `chain`: never claims more than the whole-vault verdict. A position before the break reads valid only when the
	 *   break is the vault's ONLY failure (`LedgerState.breakIsOnlyFailure`), and then while `pos` is before the
	 *   FULL-list break index (`LedgerState.fullBreakIndex`), never the slice-relative index the rows use. A vault that
	 *   also fails for a reason no event marks (a malformed or torn line, an anchor mismatch, a latched deletion), or
	 *   whose load cannot tell, is invalid at every position, break or not. With no break, it is the whole-vault verdict
	 *   (`summary.chain.valid`) at every position.
	 * - `plan`: the workspace value in force at the position's RUNNING-MAXIMUM time (`timeMsAt`: the latest time
	 *   recorded at or before it), not necessarily the event's own `ts`. In a log written in order the two are the
	 *   same; in one whose times are out of order (several writers), it is the instant `positionAt` searches over, so
	 *   `?t=` and the position it resolves read the same plan. Null when it is unset, no time up to the position parses,
	 *   settings are off, or the settings cannot be read: the rest of the answer does not depend on them.
	 * - `statusAt`: by event hash, the status at `pos` of each held row at or before `pos` whose transfer has a record
	 *   after it (`TransferIndex.openAcross`, `verdictAt`), with the mapping the rows use (`statusFor`).
	 */
	function answerAt(res: ServerResponse, params: URLSearchParams): void {
		const posArgs = params.getAll("pos");
		const tArgs = params.getAll("t");
		if (posArgs.length + tArgs.length !== 1) {
			sendJson(res, 400, { error: "give exactly one of pos or t" });
			return;
		}
		const positions = state.positions;
		const head = positions.length - 1;
		let pos: number;
		let clamped = false;
		const [posArg] = posArgs;
		if (posArg !== undefined) {
			if (!POSITION.test(posArg)) {
				sendJson(res, 400, { error: "pos must be a whole number >= 0" });
				return;
			}
			if (head < 0) {
				sendJson(res, 404, { error: "no records" });
				return;
			}
			const asked = Number(posArg);
			clamped = asked > head;
			pos = clamped ? head : asked;
		} else {
			const t = tArgs[0] as string;
			const ms = parseZonedTime(t);
			if (Number.isNaN(ms)) {
				sendJson(res, 400, {
					error: "t must be an ISO-8601 date and time with Z or an offset",
				});
				return;
			}
			const first = positions.firstTimedMs;
			const found = first === null || ms < first ? null : positions.positionAt(t);
			if (found === null) {
				sendJson(res, 404, { error: "no records before this time" });
				return;
			}
			pos = found;
		}
		const windowStartPos = state.rows[0]?.pos ?? head + 1;
		const breakIndex = state.fullBreakIndex;
		const body: AtPayload = {
			pos,
			ts: positions.tsAt(pos),
			head,
			clamped,
			epoch,
			spentUt: positions.spentUtAt(pos),
			counts: positions.countsAt(pos),
			chain: {
				valid:
					breakIndex === null
						? state.summary.chain.valid
						: state.breakIsOnlyFailure && pos < breakIndex,
				breakIndex,
			},
			budget: {
				ut: state.summary.budget,
				source: state.summary.budgetSource,
				writtenAt: state.summary.budgetWrittenAt,
				provenance: state.summary.budgetProvenance,
				note: BUDGET_NOTE,
			},
			plan: planAt(positions.timeMsAt(pos)),
			windowStartPos,
			statusAt: statusAt(pos, windowStartPos),
		};
		sendJson(res, 200, body, { "cache-control": "no-store" });
	}

	/** `plan.monthlyUt` in force at `ms`, or null: no time, settings off, or settings that cannot be read. */
	function planAt(ms: number | null): number | null {
		if (ms === null) return null;
		try {
			const ws = openWorkspace();
			return typeof ws === "string"
				? null
				: ws.valueAt("plan.monthlyUt", new Date(ms).toISOString());
		} catch {
			return null;
		}
	}

	/**
	 * The status at `pos` of each held row at or before it whose transfer has a record after it. The rows held are
	 * contiguous by position from `windowStartPos`, so a row is found by its position; one not held is skipped. A
	 * position before the first row held has no held row at or before it, and a transfer whose rows up to `pos` all fall
	 * before the window has none either: neither costs a verdict.
	 */
	function statusAt(pos: number, windowStartPos: number): Record<string, RowStatus> {
		const out: Record<string, RowStatus> = {};
		if (pos < windowStartPos) return out;
		for (const { key, rowPositions } of state.transfers.openAcross(pos)) {
			// Increasing: the last is the latest row at or before `pos`.
			const last = rowPositions.at(-1);
			if (last === undefined || last < windowStartPos) continue;
			// Undefined when `transferVerdict` gives none over the records up to `pos`: `statusFor` takes undefined
			// explicitly and reads an outcome row with no verdict as "unknown", as the rows built at load do.
			const verdict: TransferStatus | undefined = state.transfers.verdictAt(key, pos);
			for (const p of rowPositions) {
				const row = state.rows[p - windowStartPos];
				if (row === undefined || row.pos !== p) continue;
				out[row.hash] = statusFor(
					row.kind,
					row.settled !== undefined ? { settled: row.settled } : {},
					verdict,
				);
			}
		}
		return out;
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
			refuse(res, 404, { error: "not found" });
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
		if (url.pathname === "/api/at") {
			// A throw here would leave the listener and end the process: a fault is a 500 with a fixed message.
			try {
				answerAt(res, url.searchParams);
			} catch {
				if (!res.headersSent) sendJson(res, 500, { error: "position could not be read" });
				else res.destroy();
			}
			return;
		}
		if (url.pathname === "/api/session") {
			// Same-origin only by construction: no access-control-* header is ever sent, and the Host guard above
			// keeps a rebound name from reading it.
			sendJson(res, 200, { token }, { "cache-control": "no-store" });
			return;
		}
		if (url.pathname === "/api/settings" && req.method === "GET") {
			sendSettings(res);
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
				// Nothing thrown in here may leave the listener: an uncaught throw ends the process.
				try {
					putSetting(res, raw);
				} catch {
					if (!res.headersSent) sendJson(res, 500, { error: "settings request failed" });
					else res.destroy();
				}
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
			// The body is capped.
			readBody(req, res, EXPORT_BODY_CAP, (raw) => {
				try {
					const body = JSON.parse(raw || "{}") as { outDir?: string };
					if (typeof body.outDir !== "string" || body.outDir.length === 0) {
						sendJson(res, 400, { error: "outDir required" });
						return;
					}
					// Amendment A5: containment — the outDir must stay inside the project root and out of the vault
					// interior. It is judged, and written, where the OS puts it: resolved as far as it exists, links
					// followed, so a link inside the project cannot lead the export into the vault.
					const outDir = canonical(resolve(root, body.outDir));
					const vaultResolved = canonical(vaultPath);
					const insideRoot = outDir === root || outDir.startsWith(root + sep);
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
			refuse(res, 404, { error: "not found" });
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
		root,
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
