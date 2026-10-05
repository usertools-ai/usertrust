// Real usage from Claude Code's own session transcripts. Zero dependencies.
//
// WHAT THE TRANSCRIPT HOLDS (measured, shape only):
//  - One JSONL file per agent. The parent ("main") agent writes
//    <projectDir>/<sessionId>.jsonl — the hook's `transcript_path`. Every
//    subagent writes <projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl,
//    beside agent-<agentId>.meta.json (which carries `agentType`). Each
//    subagent entry repeats the same `agentId` and has `isSidechain: true`; the
//    parent file carries no subagent usage, so the files never overlap.
//  - Assistant entries carry `message.{id, model, usage, stop_reason}`. ONE API
//    response is written as SEVERAL entries sharing `message.id` (one per
//    content block, and progressively while streaming). Their input and cache
//    counts are identical; `output_tokens` only grows; the final entry is the
//    one with a non-null `stop_reason`. So usage is counted once per
//    `message.id`, from its complete entry, and an incomplete message waits for
//    the next settle point.
//  - `usage` is the provider's own response block: `input_tokens` (fresh input,
//    cache EXCLUDED), `cache_read_input_tokens`, `cache_creation_input_tokens`,
//    `output_tokens`. These four are already disjoint, which is exactly the
//    usertrust settle contract (cache tiers are never folded into inputTokens).
//
// IDEMPOTENCY: per (session, agent) the state dir keeps the set of message ids
// already accounted. Ids are CLAIMED before anything is posted and released
// only when the server proves nothing was posted, so a re-run, a crash or a
// concurrent hook can lose a settle to the next settle point but never post
// the same message twice.
import { mkdir, readdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { serverRequest, stateRoot } from "./lib.mjs";

/** Never priced: Claude Code's placeholder for locally-generated messages. */
const SYNTHETIC_MODEL = "<synthetic>";

/**
 * The hold sized for a reconciliation settle. Cache writes are priced above
 * fresh input (up to 2x for the 1-hour tier), so the hold counts them twice:
 * a hold below the real cost would cap the posted amount (shortfall) instead of
 * recording what was spent.
 */
const CACHE_WRITE_HOLD_FACTOR = 2;

/** A lock older than this is a crashed holder, not a live one. */
const STALE_LOCK_MS = 60_000;

function sanitize(part) {
	return String(part ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function nonNegativeInt(value) {
	return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * Parse one transcript into its complete assistant messages, keyed by
 * `message.id`. Returns `{ ok: false, reason }` when the file is missing,
 * unreadable, or holds no parseable line at all — the caller then falls back to
 * the estimate. Individual bad lines (a partially-flushed tail is normal) are
 * skipped and counted.
 */
export async function readTranscriptUsage(path) {
	if (typeof path !== "string" || path === "") return { ok: false, reason: "no transcript path" };
	let text;
	try {
		text = await readFile(path, "utf-8");
	} catch (err) {
		return { ok: false, reason: `transcript unreadable (${err?.code ?? "error"})` };
	}
	const messages = new Map();
	let parsedLines = 0;
	let badLines = 0;
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
			parsedLines += 1;
		} catch {
			badLines += 1;
			continue;
		}
		const message = entry?.message;
		const usage = message?.usage;
		if (typeof message?.id !== "string" || usage == null || typeof usage !== "object") continue;
		const complete = message.stop_reason != null;
		const current = {
			model: typeof message.model === "string" ? message.model : "unknown",
			inputTokens: nonNegativeInt(usage.input_tokens),
			outputTokens: nonNegativeInt(usage.output_tokens),
			cacheReadTokens: nonNegativeInt(usage.cache_read_input_tokens),
			cacheWriteTokens: nonNegativeInt(usage.cache_creation_input_tokens),
			complete,
		};
		const previous = messages.get(message.id);
		// The complete entry wins; between two of the same completeness, the
		// larger output (the stream only grows).
		if (
			previous === undefined ||
			(complete && !previous.complete) ||
			(complete === previous.complete && current.outputTokens >= previous.outputTokens)
		) {
			messages.set(message.id, current);
		}
	}
	if (parsedLines === 0) {
		return { ok: false, reason: "transcript has no parseable entries (corrupt)" };
	}
	return { ok: true, messages, badLines };
}

/** The transcript file for one agent of a session, derived from the hook input. */
export function transcriptPathFor(input, agentId) {
	if (agentId === "main") return input.transcript_path;
	if (typeof input.agent_transcript_path === "string" && input.agent_transcript_path !== "") {
		return input.agent_transcript_path;
	}
	const main = input.transcript_path;
	if (typeof main !== "string" || main === "") return undefined;
	return join(dirname(main), basename(main, ".jsonl"), "subagents", `agent-${agentId}.jsonl`);
}

/** Every subagent transcript recorded for the session, as `{ agentId, path }`. */
export async function subagentTranscripts(input) {
	const main = input.transcript_path;
	if (typeof main !== "string" || main === "") return [];
	const dir = join(dirname(main), basename(main, ".jsonl"), "subagents");
	let names;
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.startsWith("agent-") && name.endsWith(".jsonl"))
		.map((name) => ({
			agentId: name.slice("agent-".length, -".jsonl".length),
			path: join(dir, name),
		}));
}

/** `agentType` from the subagent's meta file, else the hook's, else "subagent". */
async function agentTypeFor(transcriptPath, agentId, hinted) {
	if (agentId === "main") return "main";
	try {
		const meta = JSON.parse(
			await readFile(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf-8"),
		);
		if (typeof meta?.agentType === "string" && meta.agentType !== "") return meta.agentType;
	} catch {
		// No meta file — use the hint.
	}
	return typeof hinted === "string" && hinted !== "" ? hinted : "subagent";
}

function cursorDir() {
	return join(stateRoot(), "transcripts");
}

function cursorPath(sessionId, agentId) {
	return join(cursorDir(), `${sanitize(sessionId)}__${sanitize(agentId)}.json`);
}

async function readCursor(path) {
	try {
		const parsed = JSON.parse(await readFile(path, "utf-8"));
		return new Set(
			Array.isArray(parsed?.accounted)
				? parsed.accounted.filter((id) => typeof id === "string")
				: [],
		);
	} catch {
		return new Set();
	}
}

async function writeCursor(path, accounted) {
	const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	await writeFile(tmp, JSON.stringify({ accounted: [...accounted] }));
	await rename(tmp, path);
}

/** Exclusive per-(session, agent) lock: mkdir is atomic. Returns a release fn or null. */
async function acquireLock(path) {
	const lock = `${path}.lock`;
	try {
		await mkdir(lock);
	} catch {
		try {
			const { mtimeMs } = await stat(lock);
			if (Date.now() - mtimeMs < STALE_LOCK_MS) return null;
			await rmdir(lock);
			await mkdir(lock);
		} catch {
			return null;
		}
	}
	return async () => {
		try {
			await rmdir(lock);
		} catch {
			// Already gone.
		}
	};
}

/**
 * Settle one agent's NEW complete messages at their real usage, one
 * authorize→settle pair per model. Returns a summary; never throws for a
 * server-side failure (the hook must not block), and leaves unsettled ids
 * unclaimed so the next settle point retries them.
 */
export async function settleTranscript({
	sessionId,
	agentId,
	agentTypeHint,
	transcriptPath,
	hook,
}) {
	const usage = await readTranscriptUsage(transcriptPath);
	if (!usage.ok) return { ok: false, reason: usage.reason, settled: 0 };
	if (usage.badLines > 0) {
		process.stderr.write(`usertrust: skipped ${usage.badLines} unparseable transcript line(s)\n`);
	}
	await mkdir(cursorDir(), { recursive: true });
	const path = cursorPath(sessionId, agentId);
	const release = await acquireLock(path);
	if (release === null) return { ok: true, settled: 0, skipped: "locked by a concurrent settle" };
	try {
		const accounted = await readCursor(path);
		const agentType = await agentTypeFor(transcriptPath, agentId, agentTypeHint);
		const byModel = new Map();
		const free = [];
		for (const [id, m] of usage.messages) {
			if (!m.complete || accounted.has(id)) continue;
			const total = m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens;
			if (m.model === SYNTHETIC_MODEL || total === 0) {
				free.push(id);
				continue;
			}
			const group = byModel.get(m.model) ?? {
				ids: [],
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			};
			group.ids.push(id);
			group.inputTokens += m.inputTokens;
			group.outputTokens += m.outputTokens;
			group.cacheReadTokens += m.cacheReadTokens;
			group.cacheWriteTokens += m.cacheWriteTokens;
			byModel.set(m.model, group);
		}
		if (free.length > 0) {
			for (const id of free) accounted.add(id);
			await writeCursor(path, accounted);
		}
		let settled = 0;
		const failures = [];
		for (const [model, group] of byModel) {
			// CLAIM first: from here on a crash can only lose this settle, never repeat it.
			for (const id of group.ids) accounted.add(id);
			await writeCursor(path, accounted);
			const outcome = await postGroup({ sessionId, agentId, agentType, hook, model, group });
			if (outcome.posted) {
				settled += group.ids.length;
			} else {
				if (outcome.release) {
					for (const id of group.ids) accounted.delete(id);
					await writeCursor(path, accounted);
				}
				failures.push(`${model}: ${outcome.reason}`);
			}
		}
		return { ok: true, settled, failures };
	} finally {
		await release();
	}
}

/**
 * One authorize→settle pair for a model group. `release: true` means the server
 * PROVED nothing was posted (so the ids may be retried); `false` means the
 * outcome is unknown and the ids stay claimed — at most once.
 */
async function postGroup({ sessionId, agentId, agentType, hook, model, group }) {
	let auth;
	try {
		auth = await serverRequest("/v1/authorize", {
			model,
			estimatedInputTokens:
				group.inputTokens +
				group.cacheReadTokens +
				CACHE_WRITE_HOLD_FACTOR * group.cacheWriteTokens,
			maxOutputTokens: Math.max(1, group.outputTokens),
			params: {
				hook,
				usageOrigin: "transcript",
				agent_id: agentId,
				agent_type: agentType,
				messages: group.ids.length,
			},
			actor: `claude-code:${sessionId}:${agentType}:${agentId}`,
		});
	} catch (err) {
		// No response: a hold may exist server-side, but nothing was settled; its
		// TTL sweep voids it. Safe to retry.
		return {
			posted: false,
			release: true,
			reason: `authorize unreachable: ${err?.message ?? err}`,
		};
	}
	const transferId = auth.json?.transferId;
	if (auth.status !== 200 || typeof transferId !== "string" || transferId === "") {
		const reason =
			auth.json?.shadow === true
				? "shadow mode (not recorded)"
				: `authorize returned ${auth.status}`;
		return { posted: false, release: true, reason };
	}
	let settle;
	try {
		settle = await serverRequest("/v1/settle", {
			transferId,
			inputTokens: group.inputTokens,
			outputTokens: group.outputTokens,
			cacheReadTokens: group.cacheReadTokens,
			cacheWriteTokens: group.cacheWriteTokens,
			// The counts are the provider's own usage block, copied verbatim by
			// Claude Code; `params.usageOrigin` on the authorize says where they
			// were read from.
			usageSource: "provider",
		});
	} catch (err) {
		return await voidAfterAmbiguousSettle(transferId, `settle unreachable: ${err?.message ?? err}`);
	}
	if (settle.status === 200) return { posted: true };
	// A definite non-200: the server re-queues the hold on a governor failure,
	// so void it now rather than leave it to the TTL sweep.
	return await voidAfterAmbiguousSettle(transferId, `settle returned ${settle.status}`);
}

/**
 * Abort the reconciliation hold. A 200 abort PROVES the hold was still pending
 * — nothing posted — so the ids are released for retry. Anything else leaves
 * them claimed: a 404 means the settle landed (or the hold is already gone).
 */
async function voidAfterAmbiguousSettle(transferId, reason) {
	try {
		const abort = await serverRequest("/v1/abort", {
			transferId,
			error: "transcript settle failed",
		});
		return { posted: false, release: abort.status === 200, reason };
	} catch {
		return { posted: false, release: false, reason: `${reason}; abort unreachable` };
	}
}
