// What the plugin is called, and what its four descriptions say. The plugin is `usertrust`
// (its marketplace has always been `usertrust`); its descriptions are true in every mode.
// Each test names the mutant it kills; the mutants were run against this file and reverted
// (see the pull request).

import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHook } from "./helpers/run-hook.js";

const PLUGIN = join(import.meta.dirname, "..");
const HOOKS = join(PLUGIN, "hooks");
const ROOT = join(PLUGIN, "..", "..");

const json = async (path: string) => JSON.parse(await readFile(path, "utf-8"));
const manifest = () => json(join(PLUGIN, ".claude-plugin", "plugin.json"));
const marketplace = () => json(join(ROOT, ".claude-plugin", "marketplace.json"));
const pkg = () => json(join(PLUGIN, "package.json"));

describe("the plugin's name", () => {
	it("is usertrust in the manifest and the marketplace entry, in a marketplace also named usertrust", async () => {
		// mutant: either name left as the previous one
		expect((await manifest()).name).toBe("usertrust");
		const m = await marketplace();
		expect(m.name).toBe("usertrust");
		expect(m.plugins).toHaveLength(1);
		expect(m.plugins[0].name).toBe("usertrust");
		expect(m.plugins[0].source).toBe("./packages/claude-code-plugin");
	});

	it("the README leads with usertrust and the one-line install, and keeps the two-step fallback", async () => {
		const readme = await readFile(join(PLUGIN, "README.md"), "utf-8");
		expect(readme.startsWith("# usertrust\n")).toBe(true);
		const install = readme.slice(readme.indexOf("## Install"), readme.indexOf("## Quickstart"));
		// mutant: the previous name stays in an install line
		expect(install).toContain("/plugin install usertrust --marketplace usertools-ai/usertrust");
		expect(install).toContain("/plugin marketplace add usertools-ai/usertrust");
		expect(install).toContain("/plugin install usertrust@usertrust");
		// the old names appear only in the upgrade lines
		const outsideUpgrade = install.split("Upgrading")[0] ?? "";
		expect(outsideUpgrade).not.toMatch(/usertools@|install usertools\b/);
	});

	it("the upgrade lines uninstall the previous name before installing the new one", async () => {
		const readme = await readFile(join(PLUGIN, "README.md"), "utf-8");
		const upgrade = readme.slice(readme.indexOf("Upgrading"), readme.indexOf("## Quickstart"));
		const uninstall = upgrade.indexOf("/plugin uninstall usertools@usertrust");
		const install = upgrade.indexOf("/plugin install usertrust");
		expect(uninstall).toBeGreaterThan(-1);
		expect(install).toBeGreaterThan(uninstall);
		expect(upgrade).toContain("/plugin uninstall usertrust-claude-code@usertrust");
		// said plainly: an existing install does not move to the new name by itself
		expect(upgrade).toMatch(/does not (update|migrate)/);
	});
});

describe("the four descriptions are true in every mode", () => {
	it("none says Ledger-backed or names the previous plugin, and each says it is watch-only by default", async () => {
		const readme = await readFile(join(PLUGIN, "README.md"), "utf-8");
		const readmeLead = readme.split("\n\n")[1] ?? "";
		const descriptions = {
			"plugin.json": (await manifest()).description as string,
			"marketplace.json": (await marketplace()).plugins[0].description as string,
			"package.json": (await pkg()).description as string,
			"README lead": readmeLead,
		};
		for (const [where, text] of Object.entries(descriptions)) {
			// mutant: one of the four keeps the old claim
			expect(text, where).not.toMatch(/ledger-backed/i);
			expect(text, where).not.toMatch(/usertools/i);
			expect(text.length, where).toBeGreaterThan(40);
		}
		for (const where of ["plugin.json", "marketplace.json", "package.json"] as const) {
			expect(descriptions[where], where).toMatch(/watch-only/i);
		}
		expect(descriptions["README lead"]).toMatch(/^Spend governance for Claude Code/);
	});
});

describe("state does not move with the plugin's name", () => {
	it("the default state directory is not keyed by any plugin id", async () => {
		const config = await mkdtemp(join(tmpdir(), "utcc-ident-"));
		await mkdir(join(config, "projects"), { recursive: true });
		// no UT_CC_STATE_DIR: the default, which hangs off Claude Code's config directory
		const r = await runHook(
			join(HOOKS, "session-start.mjs"),
			{ hook_event_name: "SessionStart", source: "startup", session_id: "ident-1" },
			{ CLAUDE_CONFIG_DIR: config, UT_SERVER_URL: "http://127.0.0.1:9", UT_SERVER_KEY: "k" },
		);
		expect(r.code).toBe(0);
		const names = await readdir(config);
		// mutant: the state dir is derived from the plugin's name
		expect(names).toContain("usertrust-cc");
		for (const name of names) expect(name).not.toMatch(/usertools|claude-code/i);
	});
});
