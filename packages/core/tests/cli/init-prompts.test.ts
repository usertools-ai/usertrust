// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `usertrust init` driven through the REAL prompts, with nothing mocked: the wizard is handed a
 * pair of streams, the test types into one and reads what the prompts drew on the other. A stand-in
 * for @clack/prompts would pass whatever it returned; here it is clack's own behaviour that is
 * under test, which is where two of the old defects lived (Enter at the budget prompt was refused,
 * because clack applies a default only after validating, and a key was echoed as it was typed).
 */

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as clack from "@clack/prompts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../../src/cli/init.js";

/** A key shaped like a real one, with enough distinct characters that no run of six is common text. */
const CANARY = "sk-ant-api03-Zq8vX2mK9wLd4RtB7nYcH5pJ";

interface Wizard {
	input: PassThrough;
	output: PassThrough;
	/** Everything drawn so far, with the control sequences left in. */
	drawn: () => string;
	/** Wait until `text` has been drawn, then type `keys`. */
	answer: (text: string, keys: string) => Promise<void>;
}

function wizard(): Wizard {
	const input = new PassThrough();
	const output = new PassThrough();
	let drawn = "";
	output.on("data", (chunk: Buffer) => {
		drawn += chunk.toString();
	});
	return {
		input,
		output,
		drawn: () => drawn,
		answer: async (text, keys) => {
			// timing: 10 s bound on a prompt appearing; a prompt is drawn within a few ms of the one
			// before it (the whole wizard ran in 0.2 s when measured), so the headroom is about 50x.
			const deadline = Date.now() + 10_000;
			while (!drawn.includes(text)) {
				// timing: compares against the 10 s deadline set above
				if (Date.now() > deadline) throw new Error(`the prompt "${text}" was never drawn`);
				await new Promise((resolve) => setTimeout(resolve, 5)); // timing: 5 ms poll between checks
			}
			input.write(keys);
		},
	};
}

const ENTER = "\r";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "trust-init-prompts-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Answer every prompt after the key and budget ones with Enter: recommended rates, no local runtime. */
async function finish(w: Wizard): Promise<void> {
	await w.answer("Use recommended rates", ENTER);
	await w.answer("Configure local inference", ENTER);
}

function config(): { budget: number; providers: Array<{ name: string }> } {
	return JSON.parse(readFileSync(join(dir, ".usertrust", "usertrust.config.json"), "utf-8"));
}

describe("usertrust init, through the real prompts", () => {
	it("Enter at the budget prompt accepts $5: 50,000 usertokens", async () => {
		const w = wizard();
		const done = run(dir, { skipVerify: true, input: w.input, output: w.output });
		await w.answer("Paste your API key", ENTER); // no key
		await w.answer("Total budget", ENTER);
		await finish(w);
		await done;
		expect(config().budget).toBe(50_000);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it("the budget is called a total that does not reset, and offers $5", async () => {
		const w = wizard();
		const done = run(dir, { skipVerify: true, input: w.input, output: w.output });
		await w.answer("Paste your API key", ENTER);
		await w.answer("Total budget", ENTER);
		await finish(w);
		await done;
		expect(w.drawn()).toContain("it does not reset");
		expect(w.drawn()).not.toContain("Monthly");
		// The offered value is drawn in the prompt, so Enter is an informed choice.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes from what was drawn
		const plain = w.drawn().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
		expect(plain).toMatch(
			/Total budget for this project, \$ \(it does not reset\)[\s\S]*?\n[^\n]*5/,
		);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it("a typed budget still wins over the offered one", async () => {
		const w = wizard();
		const done = run(dir, { skipVerify: true, input: w.input, output: w.output });
		await w.answer("Paste your API key", ENTER);
		await w.answer("Total budget", `\u007f2${ENTER}`); // erase the offered 5, type 2
		await finish(w);
		await done;
		expect(config().budget).toBe(20_000);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it("the key prompt echoes none of the key's characters", async () => {
		const w = wizard();
		const done = run(dir, { skipVerify: true, input: w.input, output: w.output });
		await w.answer("Paste your API key", `${CANARY}${ENTER}`);
		await w.answer("Paste another API key", ENTER);
		await w.answer("Total budget", ENTER);
		await finish(w);
		await done;
		// The key reached the vault, so it was typed and read...
		expect(readFileSync(join(dir, ".usertrust", ".env"), "utf-8")).toContain(CANARY);
		// ...and not one run of six of its characters was drawn.
		const seen = w.drawn();
		for (let at = 0; at + 6 <= CANARY.length; at++) {
			expect(seen, `characters ${at}..${at + 6} of the key were echoed`).not.toContain(
				CANARY.slice(at, at + 6),
			);
		}
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it("control: the same stream pair shows a key typed into a plain text prompt", async () => {
		const w = wizard();
		const asked = clack.text({ message: "Key:", input: w.input, output: w.output });
		await w.answer("Key:", `${CANARY}${ENTER}`);
		await asked;
		// Were this to find nothing, the test above would pass whatever the wizard drew.
		expect(w.drawn()).toContain(CANARY.slice(0, 6));
	}, 30_000); // timing: 30 s budget over a prompt that answers in milliseconds

	it("the key file is made owner-only, and holds the key", async () => {
		const w = wizard();
		const done = run(dir, { skipVerify: true, input: w.input, output: w.output });
		await w.answer("Paste your API key", `${CANARY}${ENTER}`);
		await w.answer("Paste another API key", ENTER);
		await w.answer("Total budget", ENTER);
		await finish(w);
		await done;
		const env = join(dir, ".usertrust", ".env");
		expect(existsSync(env)).toBe(true);
		if (process.platform !== "win32") expect(statSync(env).mode & 0o777).toBe(0o600);
		expect(config().providers.map((p) => p.name)).toEqual(["anthropic"]);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	/** Reconfigure over a key file that already exists, typing CANARY at the first key prompt. */
	async function reconfigureOver(existing: string, mode: number): Promise<string> {
		await run(dir, { json: true });
		const env = join(dir, ".usertrust", ".env");
		writeFileSync(env, existing, { mode });
		chmodSync(env, mode);
		const w = wizard();
		const done = run(dir, {
			skipVerify: true,
			reconfigure: true,
			input: w.input,
			output: w.output,
		});
		await w.answer("Paste your API key", `${CANARY}${ENTER}`);
		await w.answer("Paste another API key", ENTER);
		await w.answer("Total budget", ENTER);
		await finish(w);
		await done;
		return readFileSync(env, "utf-8");
	}

	it("a reconfigure that adds a key keeps every other line and comment byte for byte", async () => {
		const existing =
			'# my keys\nOPENAI_API_KEY="sk-proj-existing-0000"\n\nEXTRA_SETTING=1  # kept\n';
		const after = await reconfigureOver(existing, 0o600);
		expect(after).toBe(`${existing}ANTHROPIC_API_KEY="${CANARY}"\n`);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it("a re-typed key replaces the same variable's line, and is never a duplicate", async () => {
		const before = '# top\nANTHROPIC_API_KEY="sk-ant-old-0000"\nEXTRA_SETTING=1\n';
		const after = await reconfigureOver(before, 0o600);
		expect(after).toBe(`# top\nANTHROPIC_API_KEY="${CANARY}"\nEXTRA_SETTING=1\n`);
		expect(after.split("\n").filter((l) => l.startsWith("ANTHROPIC_API_KEY")).length).toBe(1);
	}, 30_000); // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)

	it.skipIf(process.platform === "win32")(
		"the merged key file is written atomically at 0600, whatever the old mode, with no temp file left",
		async () => {
			await reconfigureOver("EXTRA_SETTING=1\n", 0o644);
			const env = join(dir, ".usertrust", ".env");
			expect(statSync(env).mode & 0o777).toBe(0o600);
			// A rename leaves nothing beside it; an in-place write would have kept 0644.
			expect(readdirSync(join(dir, ".usertrust")).filter((n) => n.startsWith(".env"))).toEqual([
				".env",
			]);
		},
		30_000, // timing: 30 s budget over a wizard that runs in 0.2 s (about 150x headroom)
	);
});
