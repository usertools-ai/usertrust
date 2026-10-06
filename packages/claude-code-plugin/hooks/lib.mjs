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
//
// A transcript-mode hold file also names the transcript messages assigned to
// it and their counts; transcript.mjs journals its outcome beside it
// (<hold>.settling, <hold>.done), names listPending never returns.
import {
	appendFile,
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
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

/**
 * Where the plugin keeps its state: pending holds, and the transcript cursors and
 * message claims that say what was already posted. DURABLE on purpose, beside
 * Claude Code's own data (its transcripts live in the same config dir): state lost
 * while its transcripts survive would be read as "nothing posted yet". A temp dir
 * is not durable — macOS purges files untouched for three days.
 */
export function stateRoot() {
	return (
		process.env.UT_CC_STATE_DIR ??
		join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "usertrust-cc")
	);
}

const stateDir = stateRoot;

/**
 * Where real usage comes from. `transcript` (default): Claude Code's own
 * session transcript (see transcript.mjs), with the per-call estimate — labelled
 * `estimated` — only for an agent in estimate mode (its transcript cannot be
 * used, or a subagent inherits it: transcript.mjs `inheritedEstimate`).
 * `estimate`: the per-call estimate only, and each agent's estimate mode is
 * recorded (transcript.mjs `stickToEstimate`), so a session resumed without it
 * posts nothing it settled at the estimate.
 */
export function usageMode() {
	return process.env.UT_CC_USAGE === "estimate" ? "estimate" : "transcript";
}

/**
 * Whether the plugin may block a tool call. `watch` (the default) NEVER blocks,
 * and makes no permission decision at all (see `proceed` in pre-tool-use.mjs): an
 * over-budget or policy denial (402/403) is written down as a `would_block`
 * record, and a call that could not be metered (the server is unreachable, times
 * out, or answers something unusable) as a `gap` record — missed metering is
 * visible, never silent. `UT_CC_MODE=enforce` opts in to blocking: denials are
 * enforced, and a failed authorization blocks the call unless `UT_FAIL_OPEN=1`.
 * Any other value runs watch-only, and the session-start announcement names the
 * value it ignored.
 */
export function guardMode() {
	return (process.env.UT_CC_MODE ?? "").trim().toLowerCase() === "enforce" ? "enforce" : "watch";
}

/** The `UT_CC_MODE` value that was set but is not a mode, if any. */
function unrecognizedMode() {
	const raw = (process.env.UT_CC_MODE ?? "").trim();
	return raw === "" || ["watch", "enforce"].includes(raw.toLowerCase()) ? undefined : raw;
}

/** Where watch records go: one JSON object per line, beside the plugin's other state. */
export function watchLogPath() {
	return join(stateRoot(), "watch.jsonl");
}

/**
 * The one line the session-start hook shows the user, so the mode is never a
 * surprise: a watch-only plugin must not look like it is enforcing.
 */
export function modeAnnouncement() {
	if (guardMode() === "enforce") {
		return process.env.UT_FAIL_OPEN === "1"
			? `usertrust: ENFORCING — over-budget tool calls are blocked. While the server is unreachable, calls proceed unmetered (UT_FAIL_OPEN=1), each recorded as a gap in ${watchLogPath()}.`
			: "usertrust: ENFORCING — over-budget tool calls are blocked, and so is every tool call while the usertrust server is unreachable (UT_FAIL_OPEN=1 lets those through).";
	}
	const ignored = unrecognizedMode();
	const note =
		ignored === undefined
			? "Set UT_CC_MODE=enforce to block over-budget calls."
			: `UT_CC_MODE=${JSON.stringify(ignored.slice(0, 40))} is not a mode: use UT_CC_MODE=enforce to block over-budget calls.`;
	return `usertrust: watch-only — nothing is blocked. Calls that would have been blocked, and calls that could not be metered, are recorded in ${watchLogPath()}. ${note}`;
}

/**
 * Append one watch record (`would_block` or `gap`) as a JSON line, with the time,
 * session, agent and tool. Never throws: a record that cannot be written is said
 * on stderr, and the tool call proceeds either way.
 */
export async function recordWatchEvent(event) {
	const line = JSON.stringify({ at: new Date().toISOString(), ...event });
	try {
		await mkdir(stateRoot(), { recursive: true });
		await appendFile(watchLogPath(), `${line}\n`, { mode: 0o600 });
	} catch (err) {
		process.stderr.write(
			`usertrust: could not write a watch record to ${watchLogPath()} (${err instanceof Error ? err.message : String(err)}): ${line}\n`,
		);
	}
}

// Every hook gets a wall-clock budget well inside hooks.json's 15 s timeout, so
// a slow server makes a hook give up cleanly instead of being killed mid-write.
// Module evaluation is the hook's start: each hook is its own node process.
const HOOK_STARTED_AT = Date.now();
export const HOOK_BUDGET_MS = 10_000;

/** Milliseconds left in this hook's budget (negative once it is spent). */
export function timeLeft() {
	return HOOK_STARTED_AT + HOOK_BUDGET_MS - Date.now();
}

export function sanitize(part) {
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
			// A transcript-mode hold also records what it will settle: the model it
			// was authorized at, the transcript message ids assigned to it, and their
			// summed counts. An estimate-mode hold keeps the original shape exactly.
			...(entry.usage === "transcript" ? transcriptHoldFields(entry) : {}),
		}),
	);
	await rename(tmp, path);
}

const COUNT_FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"];

function countOf(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function transcriptHoldFields(entry) {
	const fields = {
		usage: "transcript",
		holdModel: String(entry.holdModel ?? "unknown"),
		assignedIds: Array.isArray(entry.assignedIds)
			? entry.assignedIds.filter((id) => typeof id === "string")
			: [],
	};
	for (const key of COUNT_FIELDS) fields[key] = countOf(entry[key]);
	// A hold authorized under a key also records the key and the agent type its
	// principal named: what a retry of its settle needs (see transcript.mjs).
	if (typeof entry.idempotencyKey === "string") fields.idempotencyKey = entry.idempotencyKey;
	if (typeof entry.agentType === "string") fields.agentType = entry.agentType;
	return fields;
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
				...(parsed.usage === "transcript" ? transcriptHoldFields(parsed) : {}),
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

/**
 * POST to the governance server. `timeoutMs` bounds the whole exchange (5 s
 * unless the caller passes less); a spent budget throws without a request.
 */
export async function serverRequest(path, body, { timeoutMs = 5000 } = {}) {
	const base = process.env.UT_SERVER_URL ?? "http://127.0.0.1:4519";
	const key = process.env.UT_SERVER_KEY ?? "";
	if (!(timeoutMs > 0)) throw new TransportError("hook time budget spent");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

// ── What the server honours ──

let capabilitiesRead;

/**
 * What the server honours (`/v1/health` `capabilities`), read once per hook
 * process. Never cached on disk: a cache could still claim keys after the server
 * was downgraded to one that strips them. Resolves to a Set — empty for an older
 * server, which publishes none — or to null when it is UNKNOWN: the probe failed
 * or ran out of time (noted on stderr, once). Unknown is not absent: a caller must
 * not send a key it cannot know is honoured, and must not treat a server that can
 * release as one that cannot (its abort would count as a breaker failure).
 *
 * WHY THIS GATES ANYTHING: an older usertrust-server's schemas STRIP request keys
 * they do not know. It would accept an `idempotencyKey` and drop it in silence —
 * and a settle retried "safely" under that key would then post twice.
 */
export function serverCapabilities() {
	capabilitiesRead ??= (async () => {
		const base = process.env.UT_SERVER_URL ?? "http://127.0.0.1:4519";
		const timeoutMs = Math.min(2_000, timeLeft());
		const unknown = (why) => {
			process.stderr.write(
				`usertrust: the server's capabilities are unknown (${why}) — this hook sends no idempotency key or principal\n`,
			);
			return null;
		};
		if (!(timeoutMs > 0)) return unknown("hook time budget spent");
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(`${base}/v1/health`, { signal: controller.signal });
			if (!response.ok) return unknown(`health returned ${response.status}`);
			const json = await response.json();
			const list = Array.isArray(json?.capabilities) ? json.capabilities : [];
			return new Set(list.filter((c) => typeof c === "string"));
		} catch (err) {
			return unknown(err instanceof Error ? err.message : String(err));
		} finally {
			clearTimeout(timeout);
		}
	})();
	return capabilitiesRead;
}

/** A server's answer that it has no such route at all: an older server, not a refusal. */
export function isUnknownRoute(response) {
	return response.status === 404 && response.json?.reason === "unknown route";
}

/**
 * The server's answer that a key's charge already stands (usertrust #205): from
 * `/v1/authorize` when an earlier settle under the key landed, and from
 * `/v1/settle` when another hold already charged it.
 */
export function isAlreadySettled(response) {
	return response.status === 409 && response.json?.error === "already_settled";
}

/**
 * Give a hold back WITHOUT calling it a failure: `/v1/release` on a server that
 * has it, so a hold that simply was not needed records no breaker failure and no
 * `llm_call_failed` (usertrust #204). An older server has only `/v1/abort`. With
 * the capabilities unknown, release is tried first: only a server that answers it
 * has no such route gets the abort.
 */
export async function releaseHold(transferId, reason, { timeoutMs = 5000 } = {}) {
	const capabilities = await serverCapabilities();
	if (capabilities === null || capabilities.has("release")) {
		const released = await serverRequest("/v1/release", { transferId, reason }, { timeoutMs });
		if (capabilities !== null || !isUnknownRoute(released))
			return { route: "release", ...released };
	}
	return {
		route: "abort",
		...(await serverRequest("/v1/abort", { transferId, error: reason }, { timeoutMs })),
	};
}

/**
 * Release remaining holds for a session — they are not failures. When agentId is
 * a string, only that agent's holds are released (SubagentStop for one subagent);
 * when it is null, every agent's holds are (Stop — the session really is ending).
 * A hold that carries assigned transcript usage is NOT released here: it is a
 * settlement, and transcript.mjs settles it. Non-200 responses and transport
 * failures are reported to stderr but never thrown. Files are cleared
 * regardless: the session (or subagent) is over, so a hold that could not be
 * released is voided server-side by the pending-TTL sweep, and keeping the file
 * would only leak state-dir entries. A hold the hook budget no longer covers is
 * left for the next Stop and the TTL sweep.
 */
export async function cleanup(sessionId, agentId) {
	for (const entry of await listPending(sessionId, agentId)) {
		if ((entry.assignedIds?.length ?? 0) > 0) continue;
		const timeoutMs = Math.min(5000, timeLeft());
		if (timeoutMs < 100) {
			process.stderr.write(`usertrust: out of time; hold ${entry.transferId} left for Stop/TTL\n`);
			return;
		}
		try {
			const response = await releaseHold(entry.transferId, "session ended with unsettled hold", {
				timeoutMs,
			});
			if (response.status !== 200) {
				process.stderr.write(
					`usertrust: ${response.route} ${entry.transferId} returned ${response.status}\n`,
				);
			}
		} catch (err) {
			process.stderr.write(
				`usertrust: failed to give back ${entry.transferId}: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
		await clearPending(sessionId, entry.agentId, entry.entryKey);
	}
}
