#!/usr/bin/env node
// The CHANGELOG guard: a pull request, graded as the merge commit GitHub tests, may only add to
// `## [Unreleased]`, with two exceptions that have their own shape.
//
//   node scripts/changelog-guard.mjs <base> <merged>
//
// `<base>` is the commit the pull request merges into (the merge commit's first parent) and `<merged>` the merge
// result itself. A pull request cut from a base that predates a CHANGELOG cut can put its Unreleased line next to
// the cut heading, and git merges it cleanly INTO the released section: the text of the pull request is right and
// the text of the merge result is wrong. So the check reads the merge result, and asserts:
//   1. A release cut: exactly one new section, headed `## [x.y.z] - YYYY-MM-DD`, right after `[Unreleased]`. It holds
//      EVERY line of the base's Unreleased section, verbatim and in order, and may add lines (upgrade notes, a known
//      issue). Unreleased is left empty and stays first. Nothing is dropped or reworded.
//   2. A released section: no existing line changes, is removed or is reordered, ever. Lines may be ADDED, and only
//      under a `### Known issues` heading inside that section (created if absent).
//   3. Everything else is added under `[Unreleased]`, whose heading stays exactly `## [Unreleased]` and the first.
// Blank lines are not content: they are ignored when lines are compared. The text above the first section is locked.
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

/** The non-blank lines of a section's body: blank lines are not content. */
const contentLines = (s) => s.body.filter((l) => l.trim() !== "");
const KNOWN_ISSUES = "### Known issues";

/**
 * Greedy in-order match of `wanted` into `lines`: the Set of indexes of `lines` that carry `wanted`, or null when some
 * wanted line is missing or out of order.
 */
function matchInOrder(wanted, lines) {
	const used = new Set();
	let at = 0;
	for (const w of wanted) {
		while (at < lines.length && lines[at] !== w) at++;
		if (at === lines.length) return null;
		used.add(at);
		at++;
	}
	return used;
}

/** True when every line of `wanted` is in `lines`, in order. */
function holdsEveryLine(wanted, lines) {
	return matchInOrder(wanted, lines) !== null;
}

/** The indexes of `lines` inside a `### Known issues` block: its heading, to the next `###` or `##` heading. */
function knownIssuesRegion(lines) {
	const region = new Set();
	let inside = false;
	lines.forEach((line, i) => {
		if (line === KNOWN_ISSUES) inside = true;
		else if (line.startsWith("### ") || line.startsWith("## ")) inside = false;
		if (inside) region.add(i);
	});
	return region;
}

const rewritten = (key) =>
	`a line inside the released section [${key}] changed, moved or was removed: a released section may only gain lines under "${KNOWN_ISSUES}"`;

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

	// The release cut: one new dated section holding every line of the base's Unreleased section, with Unreleased left empty.
	let cut = null;
	if (added.length === 1 && baseUnreleased && mergedUnreleased) {
		const [candidate] = added;
		const emptied = contentLines(mergedUnreleased).length === 0;
		const keepsEveryEntry = holdsEveryLine(contentLines(baseUnreleased), contentLines(candidate));
		if (
			CUT_HEADING.test(candidate.heading) &&
			contentLines(baseUnreleased).length > 0 &&
			emptied &&
			keepsEveryEntry
		) {
			cut = candidate;
		}
	}

	if (cut === null) {
		for (const s of added) {
			problems.push(
				`a released section [${s.key}] is added, and this is not a release cut (the new section must hold every line of the base's Unreleased section, verbatim and in order, and Unreleased must be left empty)`,
			);
		}
	}
	for (const b of base.sections) {
		if (b.key === "Unreleased") continue;
		const m = mergedByKey.get(b.key);
		if (m === undefined) {
			problems.push(`the released section [${b.key}] is gone`);
			continue;
		}
		if (b.heading !== m.heading) {
			problems.push(`the heading of the released section [${b.key}] changed`);
			continue;
		}
		const mergedLines = contentLines(m);
		const matched = matchInOrder(contentLines(b), mergedLines);
		if (matched === null) {
			problems.push(rewritten(b.key));
			continue;
		}
		const region = knownIssuesRegion(mergedLines);
		const stray = mergedLines.findIndex((_, i) => !matched.has(i) && !region.has(i));
		if (stray !== -1) {
			problems.push(
				`a line was added to the released section [${b.key}] outside "${KNOWN_ISSUES}": ${mergedLines[stray].slice(0, 60)}`,
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
