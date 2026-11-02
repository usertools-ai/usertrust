#!/usr/bin/env node
// The CHANGELOG guard: a pull request, graded as the merge commit GitHub tests, may only add to
// `## [Unreleased]`.
//
//   node scripts/changelog-guard.mjs <base> <merged>
//
// `<base>` is the commit the pull request merges into (the merge commit's first parent) and `<merged>` the merge
// result itself. A pull request cut from a base that predates a CHANGELOG cut can put its Unreleased line next to
// the cut heading, and git merges it cleanly INTO the released section: the text of the pull request is right and
// the text of the merge result is wrong. So the check reads the merge result, and asserts:
//   (a) every line the change adds sits under `## [Unreleased]`;
//   (b) no line inside a released `## [x.y.z]` section changes, and none is removed or reordered.
// The one exception is the release cut, recognised by its shape and never by who sent it: exactly one section
// is new, it is a released one (`## [x.y.z] - YYYY-MM-DD`), its body is the base's Unreleased body to the line,
// and the Unreleased section is left empty. Everything else in the file stays as it was.
//
// A change that leaves CHANGELOG.md byte-identical to the base is skipped.
//
// Exit 0: nothing to say, or the change is allowed. Exit 1: the change is refused, one line per reason. Exit 2: the
// guard could not run (usage, or git failed).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const FILE = "CHANGELOG.md";
const HEADING = /^## \[([^\]]+)\]/;
const CUT_HEADING = /^## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}$/;

/**
 * Split a CHANGELOG into its preamble and its `## ` sections. A section is keyed by the text inside the brackets of
 * its heading (`Unreleased`, `5.3.0`); a `## ` heading with no brackets is keyed by its whole line, so it is locked
 * like a release.
 */
export function parse(text) {
	const lines = text.split("\n");
	const preamble = [];
	const sections = [];
	for (const line of lines) {
		if (line.startsWith("## ")) {
			const key = HEADING.exec(line)?.[1] ?? line;
			sections.push({ key, heading: line, body: [] });
		} else if (sections.length === 0) {
			preamble.push(line);
		} else {
			sections[sections.length - 1].body.push(line);
		}
	}
	return { preamble: preamble.join("\n"), sections };
}

const bodyOf = (s) => s.body.join("\n");
const trimmedBody = (s) => bodyOf(s).replace(/^\n+/, "").replace(/\n+$/, "");

/** The reasons to refuse the change from `base` to `merged` (CHANGELOG.md text); [] when it is allowed. */
export function check(baseText, mergedText) {
	if (baseText === mergedText) return [];
	const base = parse(baseText);
	const merged = parse(mergedText);
	const problems = [];
	for (const [name, p] of [
		["base", base],
		["merged", merged],
	]) {
		const seen = new Set();
		for (const s of p.sections) {
			if (seen.has(s.key))
				problems.push(`the ${name} CHANGELOG holds two sections named [${s.key}]`);
			seen.add(s.key);
		}
	}
	if (problems.length > 0) return problems;
	if (base.preamble !== merged.preamble) problems.push("the text above the first section changed");

	const baseKeys = new Set(base.sections.map((s) => s.key));
	const mergedByKey = new Map(merged.sections.map((s) => [s.key, s]));
	const baseUnreleased = base.sections.find((s) => s.key === "Unreleased");
	const mergedUnreleased = mergedByKey.get("Unreleased");
	const added = merged.sections.filter((s) => !baseKeys.has(s.key) && s.key !== "Unreleased");

	// The release cut: one new released section that is the base's Unreleased body, to the line, with Unreleased left empty.
	let cut = null;
	if (added.length === 1 && baseUnreleased && mergedUnreleased) {
		const [candidate] = added;
		const emptied = trimmedBody(mergedUnreleased) === "";
		const sameBody = trimmedBody(candidate) === trimmedBody(baseUnreleased);
		if (
			CUT_HEADING.test(candidate.heading) &&
			trimmedBody(baseUnreleased) !== "" &&
			emptied &&
			sameBody
		) {
			cut = candidate;
		}
	}

	if (cut === null) {
		for (const s of added) {
			problems.push(
				`a released section [${s.key}] is added, and this is not a release cut (the new section must be the base's Unreleased body, to the line, with Unreleased left empty)`,
			);
		}
	}
	for (const b of base.sections) {
		if (b.key === "Unreleased") continue;
		const m = mergedByKey.get(b.key);
		if (m === undefined) {
			problems.push(`the released section [${b.key}] is gone`);
		} else if (b.heading !== m.heading || bodyOf(b) !== bodyOf(m)) {
			problems.push(
				`a line inside the released section [${b.key}] changed: a change may only add under [Unreleased]`,
			);
		}
	}
	if (baseUnreleased && !mergedUnreleased) problems.push("the [Unreleased] section is gone");
	if (mergedUnreleased && merged.sections[0] !== mergedUnreleased) {
		problems.push("[Unreleased] must stay the first section (the release script reads it there)");
	}
	if (mergedUnreleased && mergedUnreleased.heading !== "## [Unreleased]") {
		problems.push(
			"the [Unreleased] heading must be exactly `## [Unreleased]` (the release script reads it)",
		);
	}

	// Same released sections in the same order (a cut adds its one section right after Unreleased).
	const released = (p) =>
		p.sections
			.filter((s) => s.key !== "Unreleased" && (cut === null || s !== cut))
			.map((s) => s.key);
	if (released(base).join("\n") !== released(merged).join("\n") && problems.length === 0) {
		problems.push("the released sections were reordered");
	}
	if (cut !== null) {
		const order = merged.sections.map((s) => s.key);
		if (order.indexOf("Unreleased") !== order.indexOf(cut.key) - 1) {
			problems.push("the new release is not the section right after [Unreleased]");
		}
	}
	return problems;
}

function show(rev) {
	try {
		return execFileSync("git", ["show", `${rev}:${FILE}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (error) {
		const stderr = String(error.stderr ?? "");
		// A revision that holds no CHANGELOG.md reads as an empty one; a revision git cannot resolve is a failure.
		if (/exists on disk, but not in|does not exist in|path .* does not exist/i.test(stderr))
			return "";
		throw new Error(`git show ${rev}:${FILE} failed: ${stderr.trim() || error.message}`);
	}
}

function main(argv) {
	if (argv.length !== 2) {
		process.stderr.write("usage: changelog-guard.mjs <base> <merged>\n");
		return 2;
	}
	let baseText;
	let mergedText;
	try {
		baseText = show(argv[0]);
		mergedText = show(argv[1]);
	} catch (error) {
		process.stderr.write(`changelog-guard: ${error.message}\n`);
		return 2;
	}
	if (baseText === mergedText) {
		process.stdout.write(
			"changelog-guard: CHANGELOG.md is the same as the base's; nothing to check\n",
		);
		return 0;
	}
	const problems = check(baseText, mergedText);
	if (problems.length === 0) {
		process.stdout.write(
			"changelog-guard: CHANGELOG.md changes only [Unreleased] (or is a release cut)\n",
		);
		return 0;
	}
	for (const p of problems) process.stderr.write(`changelog-guard: ${p}\n`);
	process.stderr.write(
		"changelog-guard: rebase the branch on master and add the entry under [Unreleased] again\n",
	);
	return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
	process.exitCode = main(process.argv.slice(2));
