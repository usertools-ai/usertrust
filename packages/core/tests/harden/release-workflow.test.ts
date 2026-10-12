// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * THE RELEASE WORKFLOW PUBLISHES ONLY WHAT CI PASSED, AND A DRY RUN CHANGES NOTHING.
 *
 * .github/workflows/publish.yml is read as YAML (not matched as prose) and scripts/release.sh,
 * which holds its shell logic, is run against a fake `npm` and `gh` in a throwaway git
 * repository. Nothing here talks to a registry or to GitHub.
 *
 * Pinned:
 * - REQUIRED_CI_JOBS names exactly the jobs ci.yml runs on a push to master, so adding,
 *   renaming or removing a CI job fails here until the release's list follows.
 * - The release job waits for the ci-gate job and runs under the `npm-publish` environment.
 * - Order: commit and tag locally, publish dry run, push, publish, GitHub Release. Nothing
 *   is published before the commit and tag are pushed.
 * - A dry run never pushes, publishes or creates a release.
 * - The gate fails closed and names the check: missing, pending, skipped and failed CI jobs,
 *   no CI run at all, and an unreadable registry all stop the release.
 * - Republish gates on the release commit's parent only when the release commit changes
 *   nothing but the lockstep package.json "version" fields.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const releaseSteps = publish.jobs.release?.steps ?? [];
const stepIndex = (name: string): number => {
	const i = releaseSteps.findIndex((s) => s.name === name);
	if (i < 0) throw new Error(`release job has no step named "${name}"`);
	return i;
};

describe("publish.yml", () => {
	it("REQUIRED_CI_JOBS names exactly the jobs ci.yml runs on a push", () => {
		const ciNames = Object.entries(ci.jobs).map(([k, j]) => pushName(k, j));
		expect([...requiredJobs].sort()).toEqual([...ciNames].sort());
		expect(requiredJobs.length).toBeGreaterThanOrEqual(7);
	});

	it("release waits for ci-gate and runs under the npm-publish environment", () => {
		const release = publish.jobs.release as Job;
		const needs = [release.needs ?? []].flat();
		expect(needs).toContain("ci-gate");
		const env = release.environment;
		expect(typeof env === "string" ? env : env?.name).toBe("npm-publish");
	});

	it("the gate can read Actions runs, and the workflow grants nothing by default", () => {
		expect(publish.permissions).toEqual({});
		expect(publish.jobs["ci-gate"]?.permissions).toEqual({ contents: "read", actions: "read" });
		expect(publish.jobs.release?.permissions?.actions).toBe("read");
	});

	it("both jobs run the gate, and the release job runs it before installing anything", () => {
		for (const job of ["ci-gate", "release"]) {
			const steps = publish.jobs[job]?.steps ?? [];
			expect(steps.some((s) => /release\.sh gate\b/.test(s.run ?? ""))).toBe(true);
		}
		const gate = releaseSteps.findIndex((s) => /release\.sh gate\b/.test(s.run ?? ""));
		const install = releaseSteps.findIndex((s) => s.run === "npm ci");
		expect(gate).toBeGreaterThanOrEqual(0);
		expect(gate).toBeLessThan(install);
	});

	it("commits and tags, dry-runs, pushes, publishes, then releases, in that order", () => {
		const order = [
			"Commit and tag (local)",
			"The tree to publish is the tree committed",
			"Publish packages (dry run)",
			"Push the release commit and tag",
			"Publish packages",
			"Create GitHub Release",
		].map(stepIndex);
		expect(order).toEqual([...order].sort((a, b) => a - b));
	});

	it("a dry run never pushes, publishes or creates a release", () => {
		const effects =
			/\bgit push\b|\bgh release create\b|\bnpm publish\b(?!\s+--dry-run)|release\.sh publish(?!\s+--dry-run)/;
		const effectful = releaseSteps.filter((s) => effects.test(s.run ?? ""));
		expect(effectful.map((s) => s.name)).toEqual([
			"Push the release commit and tag",
			"Publish packages",
			"Create GitHub Release",
		]);
		for (const step of effectful) expect(step.if ?? "").toContain("!inputs.dry_run");
	});

	it("a republish never bumps, commits, tags or pushes", () => {
		for (const name of [
			"Refuse to bump past a version that is not fully published",
			"Refuse a version that is already released",
			"Format package.json after bump",
			"Commit and tag (local)",
			"Push the release commit and tag",
		]) {
			expect(releaseSteps[stepIndex(name)]?.if ?? "").toContain("!inputs.republish");
		}
	});

	it("only the publish step sees the npm token", () => {
		const withToken = releaseSteps.filter((s) => JSON.stringify(s).includes("NPM_TOKEN"));
		expect(withToken.map((s) => s.name)).toEqual(["Publish packages"]);
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
# publish ...: records "<package dir>|<args>" in $FAKE_LOG.
case "$1" in
view)
	state=$(awk -v s="$2" '$1 == s { print $2 }' "$FAKE_REGISTRY")
	case "$state" in
	yes) echo "\${2##*@}" ;;
	error) echo "npm error code ETIMEDOUT" >&2; exit 1 ;;
	*) echo "npm error code E404" >&2; exit 1 ;;
	esac
	;;
publish) echo "$(basename "$PWD")|$*" >> "$FAKE_LOG" ;;
*) echo "fake npm: unexpected $*" >&2; exit 99 ;;
esac
`;

const FAKE_GH = `#!/usr/bin/env bash
# api <path>: records the path in $FAKE_LOG; answers runs from $FAKE_RUNS, jobs from $FAKE_JOBS.
[ "$1" = api ] || { echo "fake gh: unexpected $*" >&2; exit 99; }
echo "gh|$2" >> "$FAKE_LOG"
case "$2" in
*/actions/workflows/ci.yml/runs*) cat "$FAKE_RUNS" ;;
*/actions/runs/*/jobs*) cat "$FAKE_JOBS" ;;
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

function run(args: string[], env: Record<string, string> = {}) {
	const r = spawnSync("bash", [join(repo, "scripts/release.sh"), ...args], {
		cwd: repo,
		encoding: "utf8",
		env: {
			...gitEnv(),
			PATH: `${join(dir, "bin")}:${process.env.PATH}`,
			FAKE_REGISTRY: join(dir, "registry"),
			FAKE_RUNS: join(dir, "runs.json"),
			FAKE_JOBS: join(dir, "jobs.json"),
			FAKE_LOG: join(dir, "log"),
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
	setRegistry([]);
	setCi(allGreen());
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("release.sh publish", { timeout: 30_000 }, () => {
	it("dry run: the real publish command plus --dry-run, for every package, in order", () => {
		const r = run(["publish", "--dry-run"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(DIRS.map((d) => `${d}|publish --access public --provenance --dry-run`));
	});

	it("real run: the same command without --dry-run", () => {
		const r = run(["publish"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(DIRS.map((d) => `${d}|publish --access public --provenance`));
	});

	it("skips a version already on npm (finishing a partial publish)", () => {
		setRegistry(["usertrust@1.0.0 yes", "usertrust-verify@1.0.0 yes"]);
		const r = run(["publish"]);
		expect(r.status).toBe(0);
		expect(log()).toEqual(DIRS.slice(2).map((d) => `${d}|publish --access public --provenance`));
	});

	it("an unreadable registry stops it before that package, never reads as 'not published'", () => {
		setRegistry(["usertrust-openclaw@1.0.0 error"]);
		const r = run(["publish"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("usertrust-openclaw@1.0.0");
		expect(log()).toEqual(DIRS.slice(0, 2).map((d) => `${d}|publish --access public --provenance`));
	});

	it("refuses packages that disagree on the version", () => {
		writeFileSync(
			join(repo, "packages/ui/package.json"),
			JSON.stringify({ name: "usertrust-ui", version: "1.0.1" }),
		);
		const r = run(["publish", "--dry-run"]);
		expect(r.status).not.toBe(0);
		expect(r.err).toContain("packages/ui is at 1.0.1");
		expect(log()).toEqual([]);
	});

	it("rejects an unknown flag", () => {
		expect(run(["publish", "--force"]).status).not.toBe(0);
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
	it("gates on the parent of a version-only release commit", () => {
		const parent = git("rev-parse", "HEAD");
		releaseCommit("1.0.1");
		const r = run(["gate"], { REPUBLISH: "true" });
		expect(r.status).toBe(0);
		expect(log()[0]).toContain(`head_sha=${parent}&`);
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
		expect(r.err).toContain("tag v1.0.0 does not exist");
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
		expect(r.err).toContain("changes README");
	});
});
