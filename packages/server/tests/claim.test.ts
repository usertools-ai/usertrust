// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * One way out of `pending`.
 *
 * An entry used to leave `pending` in four places (settle, abort, release, the sweep) and only the sweep
 * registered a terminal for a racing settle to wait on, so a settle landing mid-void on a client release or
 * abort polled 2 s and answered a 409 the plugin reads as "claimed": the usage was never charged or
 * recorded. Two rounds of that class were patched by handler. `claim` is now the only code that removes an
 * entry, and it registers the terminal in the same step. This pins the structure: a handler that takes an
 * entry out on its own is the regression, whatever it is called.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(import.meta.dirname, "..", "src", "server.ts"), "utf-8");
// Comments may name the calls; only code counts.
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the claim is the only way an entry leaves pending", () => {
	it("server.ts holds exactly one delete call on pending, and no clear call", () => {
		expect(code.match(/\bpending\.delete\(/g)?.length).toBe(1);
		expect(code.match(/\bpending\.clear\(/g) ?? []).toEqual([]);
	});

	it("the one delete sits inside claim, beside the registration of its terminal", () => {
		const start = code.indexOf("function claim<");
		const del = code.indexOf("pending.delete(");
		const register = code.indexOf("claimed.set(");
		expect(start).toBeGreaterThan(-1);
		expect(del).toBeGreaterThan(start);
		expect(register).toBeGreaterThan(del);
		// Nothing can yield between the delete and the registration: claim itself never awaits (the
		// terminal runs inside an async wrapper that is started, not awaited, before `claimed.set`).
		const end = code.indexOf("\n\t}\n", start);
		const body = code.slice(start, end);
		// the only await is the terminal's own, inside the wrapper that is started (not awaited) here
		expect(body.match(/\bawait\b/g)?.length).toBe(1);
		expect(body).toContain("await work()");
		expect(body).not.toMatch(/\)\.then\(/);
	});
});
