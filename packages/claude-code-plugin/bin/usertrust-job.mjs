#!/usr/bin/env node
// usertrust-job — say which job this Claude Code session is working on.
//
//   node usertrust-job.mjs start <job-id>   the job from the NEXT tool call on
//   node usertrust-job.mjs stop             no job from the next tool call on
//   node usertrust-job.mjs coverage <job-id> --vault <.usertrust dir> [--jobs <dir>] [--watch <file>]
//
// Run it as an ordinary Bash call; the session id is $CLAUDE_CODE_SESSION_ID. It
// writes only to the session's job log (hooks/job-log.mjs), and REFUSES, writing
// nothing, when the log does not already exist with the plugin's `session-start`.
// `coverage` is read-only. It prints the job's tagged cost and the KNOWN GAPS in the evidence
// behind it: a diagnostic, never a certification.
//
// In a session, every path comes from the session's pin, as every hook's settings do: a
// state dir changed since the session began is not where its hooks keep its log. A
// session with no pin yet is pinned now (hooks/session.mjs), as its next hook would be:
// the one write outside the state dir, and `coverage`'s only one.
//
// Exit codes: 0 done, 1 refused (no usable log), 2 bad usage.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { passwdHome, useSession } from "../hooks/config.mjs";
import {
	appendJobOp,
	DEFAULT_WAIT_MS,
	JOB_ID,
	jobCoverage,
	jobsDir,
	readLogs,
} from "../hooks/job-log.mjs";
import { say, watchLogPath } from "../hooks/lib.mjs";
import { sessionSettings } from "../hooks/session.mjs";

const [command, ...rest] = process.argv.slice(2);

/** This session's settings, from its pin, before any path is computed. Outside a session, none. */
function usePinnedSession() {
	const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
	if (typeof sessionId !== "string" || sessionId === "") return;
	const uid = typeof process.getuid === "function" ? process.getuid() : null;
	const session = sessionSettings({
		payload: { session_id: sessionId },
		passwdHome: passwdHome(),
		uid,
	});
	useSession(session.settings);
}

function usage(why) {
	say(`usertrust-job: ${why}`);
	say("usage: usertrust-job start <job-id> | stop | coverage <job-id> [--vault DIR] [--jobs DIR]");
	process.exit(2);
}

function waitMs() {
	const raw = process.env.UT_CC_JOB_WAIT_MS;
	const n = raw === undefined ? Number.NaN : Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WAIT_MS;
}

/** Every `*.jsonl` under <vault>/audit, parsed line by line (read-only). */
async function readRecords(vault) {
	const dir = join(vault, "audit");
	const records = [];
	let unparsed = 0;
	for (const name of (await readdir(dir)).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of (await readFile(join(dir, name), "utf-8")).split("\n")) {
			if (line === "") continue;
			try {
				records.push(JSON.parse(line));
			} catch {
				// Never a silent drop: a line that cannot be read may be spend, so it is counted
				// and reported as incomplete evidence (verifying the chain is the verifier's job).
				unparsed += 1;
			}
		}
	}
	return { records, unparsed };
}

/** The plugin's watch records (one JSON object per line); a missing file is none, an unreadable one is no verdict. */
async function readWatch(path) {
	const out = [];
	let text;
	try {
		text = await readFile(path, "utf-8");
	} catch (err) {
		// Only a file that is not there means "no watch records". One that exists and cannot
		// be read may hold the very gap or refusal that makes the answer "no": no verdict.
		if (err?.code === "ENOENT") return out;
		say(`usertrust-job: the watch records cannot be read (${err?.code ?? "error"}): no verdict`);
		process.exit(1);
	}
	for (const line of text.split("\n")) {
		if (line === "") continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A line that cannot be read may be a gap or a refusal: coverage reports it as evidence incomplete.
			out.push({ kind: "unreadable" });
		}
	}
	return out;
}

try {
	usePinnedSession();
	if (command === "start" || command === "stop") {
		const wantsId = command === "start";
		if (rest.length !== (wantsId ? 1 : 0)) {
			usage(wantsId ? "start takes exactly one job id" : "stop takes no argument");
		}
		if (wantsId && !JOB_ID.test(rest[0])) {
			usage("a job id is 1-128 characters of [A-Za-z0-9._:-]");
		}
		const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
		if (typeof sessionId !== "string" || sessionId === "") {
			say("usertrust-job: CLAUDE_CODE_SESSION_ID is not set, so there is no session to label");
			process.exit(2);
		}
		const result = await appendJobOp(sessionId, command, wantsId ? rest[0] : null, {
			waitMs: waitMs(),
		});
		if (!result.ok) {
			say(`usertrust-job: ${result.reason}`);
			process.exit(1);
		}
		if (result.noop) say("usertrust-job: no job is open");
		else if (wantsId) say(`usertrust-job: job ${rest[0]} from the next tool call`);
		else say("usertrust-job: no job from the next tool call");
	} else if (command === "coverage") {
		const job = rest[0];
		if (job === undefined || !JOB_ID.test(job)) usage("coverage takes a valid job id");
		const flags = new Map();
		for (let i = 1; i < rest.length; i += 2) {
			if (!["--vault", "--jobs", "--watch"].includes(rest[i]) || rest[i + 1] === undefined) {
				usage("coverage takes --vault DIR, --jobs DIR and --watch FILE");
			}
			flags.set(rest[i], rest[i + 1]);
		}
		if (!flags.has("--vault")) usage("coverage needs --vault <the .usertrust directory>");
		let report;
		try {
			const audit = await readRecords(flags.get("--vault"));
			report = jobCoverage({
				job,
				logs: await readLogs(flags.get("--jobs") ?? jobsDir()),
				records: audit.records,
				watch: await readWatch(flags.get("--watch") ?? watchLogPath()),
				unreadable: { audit: audit.unparsed },
			});
		} catch (err) {
			// The evidence cannot be read: no verdict. The path is argv, so it goes out through
			// `say` (control characters scrubbed), never as an unhandled rejection Node prints raw.
			say(
				`usertrust-job: cannot read the evidence under ${flags.get("--vault")} (${err?.code ?? "error"}): no verdict`,
			);
			process.exit(1);
		}
		// JSON.stringify escapes C0 but leaves DEL and C1 (U+007F-U+009F) raw, and some of those
		// are 8-bit terminal introducers: escape them too, so no argv- or vault-derived byte reaches
		// a terminal as itself.
		const safe = JSON.stringify(report).replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the intent
			/[\u007f-\u009f]/g,
			(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);
		process.stdout.write(`${safe}\n`);
	} else {
		usage("unknown command");
	}
} catch (err) {
	// Any failure the command did not foresee (a write to a read-only state dir, a vanished file)
	// is reported through the scrubber with no stack and no raw path: Node's uncaught-error
	// renderer would print both, and the path is argv or environment.
	say(`usertrust-job: failed (${err?.code ?? "error"}); nothing was recorded`);
	process.exit(1);
}
