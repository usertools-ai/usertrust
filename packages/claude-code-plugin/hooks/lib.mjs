// Shared runtime for usertrust Claude Code hooks. Zero dependencies — node
// built-ins only, because hooks execute without an install step.
//
// State store design: each pending hold lives in its OWN file
// (<stateDir>/<safeSession>__<safeAgent>__<safeEntryKey>.json). Hooks for the
// same session can run concurrently; because there is no shared file to
// read-modify-write, no locking is needed — concurrent-hook safety holds by
// construction.
//
// The agent dimension matters because Claude Code reuses one session_id across
// the parent and EVERY subagent (only agent_id is per-subagent). Keying holds
// by agent lets SubagentStop void just the stopping subagent's reservations
// without touching the parent's or a sibling's in-flight holds. The agent id is
// also stored inside each file so a whole-session sweep can recover it without
// re-splitting the (ambiguous, "__"-containing) filename.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export class TransportError extends Error {
	constructor(message) {
		super(message);
		this.name = "TransportError";
	}
}

export function readStdin() {
	return new Promise((resolve, reject) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => resolve(data));
		process.stdin.on("error", reject);
	});
}

export function estimateTokens(text) {
	return Math.max(1, Math.ceil(text.length / 4));
}

/** Shared 16 KiB content cap: tool_input is truncated here, and the output hold is sized to the same bound. */
export const MAX_CONTENT_CHARS = 16 * 1024;

// Conservative output hold: same 16 KiB cap as input, via estimateTokens, so a
// settle of (input + output) at the cap cannot price above the reservation
// (AUD-004). Leaving this at 1 under-debited the wallet on every large result.
export const MAX_OUTPUT_TOKENS = estimateTokens("x".repeat(MAX_CONTENT_CHARS));

function stateDir() {
	return process.env.UT_CC_STATE_DIR ?? join(tmpdir(), "usertrust-cc");
}

function sanitize(part) {
	return String(part ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Path of the pending-hold file for one (session, agent, entry) triple. */
export function stateFilePath(sessionId, agentId, entryKey) {
	return join(
		stateDir(),
		`${sanitize(sessionId)}__${sanitize(agentId)}__${sanitize(entryKey)}.json`,
	);
}

/**
 * Record a pending hold as its own file (atomic: tmp + rename). The entry key
 * is the toolUseId when present, else the transferId. The agent id is stored in
 * the file body so a whole-session sweep can recover which agent owns the hold.
 */
export async function recordPending(sessionId, agentId, entry) {
	const entryKey = entry.toolUseId ?? entry.transferId;
	const path = stateFilePath(sessionId, agentId, entryKey);
	await mkdir(stateDir(), { recursive: true });
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(
		tmp,
		JSON.stringify({
			toolUseId: entry.toolUseId ?? null,
			transferId: entry.transferId,
			agentId: String(agentId ?? "main"),
			// Persist the authorize-time input estimate so settle can price both
			// legs. Without it, post-tool-use sent only outputTokens and a large
			// result priced above the 1-token hold (AUD-004).
			...(typeof entry.estimatedInputTokens === "number"
				? { estimatedInputTokens: entry.estimatedInputTokens }
				: {}),
		}),
	);
	await rename(tmp, path);
}

/**
 * List pending holds for a session, oldest first (by mtime). When agentId is a
 * string, only that agent's holds are returned; when it is null, holds for
 * EVERY agent in the session are returned (whole-session sweep). Corrupt or
 * concurrently-removed files are skipped — never brick a hook.
 */
export async function listPending(sessionId, agentId) {
	const prefix = `${sanitize(sessionId)}__`;
	const wantAgent = agentId == null ? null : sanitize(agentId);
	let names;
	try {
		names = await readdir(stateDir());
	} catch {
		return [];
	}
	const entries = [];
	for (const name of names) {
		if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
		const path = join(stateDir(), name);
		try {
			const parsed = JSON.parse(await readFile(path, "utf-8"));
			if (!parsed || typeof parsed.transferId !== "string") continue;
			// agentId lives in the body; the filename's "__" split is ambiguous
			// because sanitized ids can themselves contain "__".
			const entryAgent = sanitize(parsed.agentId ?? "main");
			if (wantAgent !== null && entryAgent !== wantAgent) continue;
			const { mtimeMs } = await stat(path);
			entries.push({
				entryKey: sanitize(parsed.toolUseId ?? parsed.transferId),
				agentId: entryAgent,
				toolUseId: parsed.toolUseId ?? null,
				transferId: parsed.transferId,
				...(typeof parsed.estimatedInputTokens === "number"
					? { estimatedInputTokens: parsed.estimatedInputTokens }
					: {}),
				mtimeMs,
			});
		} catch {
			// Corrupt or vanished entry — skip.
		}
	}
	entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.entryKey < b.entryKey ? -1 : 1));
	return entries.map(({ mtimeMs: _mtimeMs, ...entry }) => entry);
}

/**
 * Find the pending hold for a tool call within one agent's holds. A non-empty
 * toolUseId matches that row or returns null — it must NOT fall through to
 * another tool's reservation (AUD-005). The oldest-entry fallback is only for
 * hosts that omit tool_use_id (missing/null/empty). Does NOT delete — the
 * caller clears the file only after a successful settle (clearPending), so a
 * failed settle leaves the hold for Stop cleanup.
 */
export async function takePendingEntry(sessionId, agentId, toolUseId) {
	const entries = await listPending(sessionId, agentId);
	if (typeof toolUseId === "string" && toolUseId !== "") {
		return entries.find((entry) => entry.toolUseId === toolUseId) ?? null;
	}
	return entries[0] ?? null;
}

/** Delete one pending-hold file. Idempotent — a missing file is fine. */
export async function clearPending(sessionId, agentId, entryKey) {
	try {
		await unlink(stateFilePath(sessionId, agentId, entryKey));
	} catch {
		// Already cleared.
	}
}

export async function serverRequest(path, body) {
	const base = process.env.UT_SERVER_URL ?? "http://127.0.0.1:4519";
	const key = process.env.UT_SERVER_KEY ?? "";
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	try {
		const response = await fetch(`${base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await response.text();
		let json = null;
		try {
			json = text === "" ? null : JSON.parse(text);
		} catch {
			json = null;
		}
		return { status: response.status, json };
	} catch (err) {
		throw new TransportError(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Abort remaining holds for a session. When agentId is a string, only that
 * agent's holds are aborted (SubagentStop for one subagent); when it is null,
 * every agent's holds are aborted (Stop — the session really is ending).
 * Non-200 abort responses and transport failures are reported to stderr but
 * never thrown. Files are cleared regardless: the session (or subagent) is over,
 * so an unabortable hold is voided server-side by the pending-TTL sweep, and
 * keeping the file would only leak state-dir entries.
 */
export async function cleanup(sessionId, agentId) {
	for (const entry of await listPending(sessionId, agentId)) {
		try {
			const response = await serverRequest("/v1/abort", {
				transferId: entry.transferId,
				error: "session ended with unsettled hold",
			});
			if (response.status !== 200) {
				process.stderr.write(`usertrust: abort ${entry.transferId} returned ${response.status}\n`);
			}
		} catch (err) {
			process.stderr.write(
				`usertrust: failed to abort ${entry.transferId}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		await clearPending(sessionId, entry.agentId, entry.entryKey);
	}
}
