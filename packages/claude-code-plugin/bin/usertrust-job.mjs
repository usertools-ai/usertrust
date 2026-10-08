#!/usr/bin/env node
// usertrust-job — say which job this Claude Code session is working on.
//
//   node usertrust-job.mjs start <job-id>   the job from the NEXT tool call on
//   node usertrust-job.mjs stop             no job from the next tool call on
//   node usertrust-job.mjs coverage <job-id> [--vault <.usertrust dir>] [--jobs <dir>]
//
// Run it as an ordinary Bash call; the session id is $CLAUDE_CODE_SESSION_ID. It
// writes only to the session's job log (hooks/job-log.mjs), and REFUSES, writing
// nothing, when the log does not already exist with the plugin's `session-start`.
// `coverage` is read-only: the one answer path for "is this job's cost exact".
//
// Exit codes: 0 done, 1 refused (no usable log), 2 bad usage.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	appendJobOp,
	DEFAULT_WAIT_MS,
	JOB_ID,
	jobCoverage,
	jobsDir,
	readLogs,
} from "../hooks/job-log.mjs";
import { say } from "../hooks/lib.mjs";

const [command, ...rest] = process.argv.slice(2);

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
	const out = [];
	for (const name of (await readdir(dir)).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of (await readFile(join(dir, name), "utf-8")).split("\n")) {
			if (line === "") continue;
			try {
				out.push(JSON.parse(line));
			} catch {
				// A torn or corrupt line is the verifier's finding, not this command's.
			}
		}
	}
	return out;
}

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
		if (!["--vault", "--jobs"].includes(rest[i]) || rest[i + 1] === undefined) {
			usage("coverage takes --vault DIR and --jobs DIR");
		}
		flags.set(rest[i], rest[i + 1]);
	}
	if (!flags.has("--vault")) usage("coverage needs --vault <the .usertrust directory>");
	const report = jobCoverage({
		job,
		logs: await readLogs(flags.get("--jobs") ?? jobsDir()),
		records: await readRecords(flags.get("--vault")),
	});
	process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
	usage("unknown command");
}
