#!/usr/bin/env node
// The `tested-tree` job's verdict: did every job of this run pass? If so, the stamp.
//
// ci.yml ends with a job named `tested-tree` (a stable name) that `needs:` every other job and runs this
// script. When every job passed, it prints ONE workflow command, `::notice title=tested-tree::tested-tree
// <TESTED_SHA>`, which GitHub stores as an annotation on that check run. TESTED_SHA is github.sha: the commit
// the run TESTED (GitHub's merge commit on a pull request, the pushed commit on a push, including a
// `candidate/**` merge commit a merge tool pushes to test master plus a pull request before merging it).
// A merge tool can then prove that the exact tree it is about to land passed CI. A failing verdict
// prints no annotation at all. It needs no permission and reads no code of the change.
//
// Env:
//   RESULTS     toJSON(needs): {"<job>": {"result": "success" | "failure" | "cancelled" | "skipped", ...}}
//   REQUIRED    space-separated job ids that must be `success`; every other job may also be `skipped`
//   TESTED_SHA  github.sha (40 hex)
//
// Exit 0 when every job passed by that rule (the annotation printed once), 1 otherwise (each failing job
// named, NO annotation), 2 on unusable input.

export function verdict(results, required) {
	if (
		results === null ||
		typeof results !== "object" ||
		Array.isArray(results) ||
		Object.keys(results).length === 0
	) {
		return ["no needed jobs"];
	}
	const bad = required.filter((job) => !(job in results)).map((job) => `${job}=absent`);
	for (const job of Object.keys(results).sort()) {
		const v = results[job];
		const r = v !== null && typeof v === "object" ? v.result : undefined;
		if (!(r === "success" || (r === "skipped" && !required.includes(job)))) bad.push(`${job}=${r}`);
	}
	return bad;
}

export function main(env, out = console.log, err = console.error) {
	let results;
	try {
		results = JSON.parse(env.RESULTS ?? "");
	} catch {
		err("tested-tree: RESULTS is not JSON");
		return 2;
	}
	const sha = env.TESTED_SHA ?? "";
	if (!/^[0-9a-f]{40}$/.test(sha)) {
		err(`tested-tree: TESTED_SHA is not a commit sha: ${JSON.stringify(sha)}`);
		return 2;
	}
	const bad = verdict(results, (env.REQUIRED ?? "").split(/\s+/).filter(Boolean));
	if (bad.length > 0) {
		out(`tested-tree: NOT passed: ${bad.join(" ")}`);
		return 1;
	}
	out(`tested-tree: passed (${Object.keys(results).length} jobs)`);
	out(`::notice title=tested-tree::tested-tree ${sha}`); // the stamp, exactly once, only when every job passed
	return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = main(process.env);
}
