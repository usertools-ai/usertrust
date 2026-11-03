// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allowHostNotice, parseAllowHost, parseAllowHosts } from "../src/server/allow-host.js";
import { parseUiArgs } from "../src/server/args.js";
import { createUiServer, type UiServer } from "../src/server/server.js";

/** Raw HTTP request: lets a test set the Host and Origin headers a browser would send. */
function rawRequest(
	port: number,
	options: { method?: string; path: string; headers?: Record<string, string> },
): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const req = request(
			{
				host: "127.0.0.1",
				port,
				method: options.method ?? "GET",
				path: options.path,
				headers: options.headers,
			},
			(res) => {
				res.resume();
				res.on("end", () => resolvePromise(res.statusCode ?? 0));
			},
		);
		req.on("error", reject);
		req.end();
	});
}

const NAME = "dash.example-tailnet.ts.net";

describe("usertrust-ui --allow-host", () => {
	let tempDir: string;
	let ui: UiServer | undefined;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-ui-allow-"));
		mkdirSync(join(tempDir, ".usertrust", "audit"), { recursive: true });
	});
	afterEach(async () => {
		await ui?.close();
		ui = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("CONTROL: with no --allow-host the name is refused, as it always was", async () => {
		ui = await createUiServer(tempDir, { port: 0 });
		for (const host of [NAME, `${NAME}:${ui.port}`]) {
			expect(await rawRequest(ui.port, { path: "/api/summary", headers: { host } })).toBe(403);
		}
		// and loopback still passes, so the 403s above are the guard and not a dead server
		expect(
			await rawRequest(ui.port, {
				path: "/api/summary",
				headers: { host: `127.0.0.1:${ui.port}` },
			}),
		).toBe(200);
	});

	it("an allowed host passes a GET, with or without the port, in any letter case", async () => {
		// mutant: the Host check ignores allowHosts → every row here is 403
		ui = await createUiServer(tempDir, { port: 0, allowHosts: [NAME] });
		for (const host of [NAME, `${NAME}:${ui.port}`, NAME.toUpperCase()]) {
			expect(await rawRequest(ui.port, { path: "/api/summary", headers: { host } })).toBe(200);
		}
	});

	it("an allowed host passes a same-origin POST (https, http, http with the port) and an origin-less one", async () => {
		ui = await createUiServer(tempDir, { port: 0, allowHosts: [NAME] });
		for (const origin of [
			`https://${NAME}`,
			`http://${NAME}`,
			`http://${NAME}:${ui.port}`,
			undefined,
		]) {
			const headers: Record<string, string> = { host: NAME };
			if (origin !== undefined) headers.origin = origin;
			// past both guards a POST reaches routing: 404, there is no such route
			expect(await rawRequest(ui.port, { method: "POST", path: "/api/anything", headers })).toBe(
				404,
			);
		}
	});

	it("another host is still 403 with --allow-host set, including look-alikes and the wrong port", async () => {
		// mutant: allow-any-host (the Host check passes whenever allowHosts is non-empty) → these pass
		ui = await createUiServer(tempDir, { port: 0, allowHosts: [NAME] });
		for (const host of [
			"evil.example.com",
			`evil.example.com:${ui.port}`,
			`${NAME}.evil.example.com`,
			`evil${NAME}`,
			`x.${NAME}`,
			`${NAME}:${ui.port + 1}`,
			`${NAME}@evil.example.com`,
			`${NAME}.`,
		]) {
			expect(await rawRequest(ui.port, { path: "/api/summary", headers: { host } })).toBe(403);
		}
	});

	it("a foreign Origin POST is still 403, for an allowed host too", async () => {
		// mutant: the Origin check is skipped when the Host is an allowed one → the first row passes
		ui = await createUiServer(tempDir, { port: 0, allowHosts: [NAME] });
		for (const origin of [
			"https://evil.example.com",
			"http://evil.example.com",
			`https://${NAME}.evil.example.com`,
			`https://${NAME}:${ui.port}`,
			`http://${NAME}:${ui.port + 1}`,
			"null",
		]) {
			expect(
				await rawRequest(ui.port, {
					method: "POST",
					path: "/api/anything",
					headers: { host: NAME, origin },
				}),
			).toBe(403);
		}
		// and an allowed Origin does not rescue a loopback Host's foreign one
		expect(
			await rawRequest(ui.port, {
				method: "POST",
				path: "/api/anything",
				headers: { host: `127.0.0.1:${ui.port}`, origin: "http://evil.example.com" },
			}),
		).toBe(403);
	});

	it("the bind stays loopback, whatever is allowed", async () => {
		ui = await createUiServer(tempDir, { port: 0, allowHosts: [NAME] });
		const address = ui.server.address();
		expect(address).toMatchObject({ address: "127.0.0.1" });
	});

	// Untrusted text printed to a terminal must carry no control character. JSON.stringify escapes the C0
	// range but passes C1 (a CSI byte), DEL and the bidi overrides through, so a refusal names the value by
	// position and repeats none of it. mutant: the value is echoed (JSON.stringify) → this row fails.
	it("a refused value is never echoed: no control character reaches the message", async () => {
		// Built from code points, not written as characters: a bidi control in this source would reorder how it is read.
		const ranges: Array<[number, number?]> = [
			[0x00, 0x1f],
			[0x7f, 0x9f],
			[0x61c],
			[0x200e, 0x200f],
			[0x202a, 0x202e],
			[0x2066, 0x2069],
		];
		const CONTROL = new RegExp(
			`[${ranges.map(([a, b]) => (b === undefined ? `\\u{${a.toString(16)}}` : `\\u{${a.toString(16)}}-\\u{${b.toString(16)}}`)).join("")}]`,
			"u",
		);
		const hostile = [
			"a\u009b2Jb",
			"a\u001b[2Jb",
			"a\u007fb",
			`a${String.fromCodePoint(0x202e)}b`,
			`a${String.fromCodePoint(0x2066)}b`,
			"*\u009b",
		];
		// positive control: the check sees a planted control character, including one JSON.stringify leaves raw
		expect(CONTROL.test(JSON.stringify("x\u009by"))).toBe(true);
		expect(CONTROL.test("--allow-host value 1 must be a bare host name")).toBe(false);
		for (const value of hostile) {
			const parsed = parseAllowHosts(["ok-host", value]);
			expect(parsed.ok).toBe(false);
			if (parsed.ok) continue;
			expect(parsed.error).not.toMatch(CONTROL);
			expect(parsed.error).not.toContain(value);
			expect(parsed.error).toMatch(/^--allow-host value 2 /);
			const args = parseUiArgs(["--allow-host", value]);
			expect(args).toMatchObject({ ok: false, code: 2 });
			if (!args.ok) expect(args.message).not.toMatch(CONTROL);
			const refused = await createUiServer(tempDir, { port: 0, allowHosts: [value] }).then(
				() => undefined,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			);
			expect(refused, "createUiServer refused").toBeDefined();
			expect(refused).not.toMatch(CONTROL);
		}
	});

	it("createUiServer refuses a wildcard or invalid name rather than starting", async () => {
		// mutant: the wildcard check is removed → the first row starts a server
		for (const bad of ["*", "*.ts.net", "evil.com/path", "10.0.0.5", "[::1]", "a b"]) {
			await expect(createUiServer(tempDir, { port: 0, allowHosts: [bad] })).rejects.toThrow(
				/--allow-host/,
			);
		}
	});
});

describe("--allow-host names", () => {
	it("accepts DNS host names, lower-cased, and drops loopback and repeats", () => {
		expect(parseAllowHost("Dash.Example-Tailnet.TS.net")).toEqual({
			ok: true,
			name: "dash.example-tailnet.ts.net",
		});
		expect(parseAllowHost("dash")).toEqual({ ok: true, name: "dash" });
		const both = parseAllowHosts([NAME, "localhost", "127.0.0.1", NAME.toUpperCase()]);
		expect(both).toEqual({ ok: true, names: [NAME] });
	});

	it("refuses wildcards, IP literals, ports, schemes, paths and malformed labels", () => {
		// mutant: wildcard accepted → "*" and "*.ts.net" come back ok
		for (const bad of [
			"",
			"*",
			"*.ts.net",
			"das*",
			"192.168.1.5",
			"100.64.0.1",
			"::1",
			"[::1]",
			"2001:db8::1",
			"10.1",
			"dash:4180",
			"https://dash",
			"dash/",
			"-dash",
			"dash-",
			"dash..net",
			".dash",
			"dash.",
			"das_h",
			"da sh",
			"dash@evil.com",
			"a".repeat(64),
			`${"a.".repeat(130)}com`,
		]) {
			expect(parseAllowHost(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
		}
	});

	it("names the allowed hosts and the warning in the startup line", () => {
		const line = allowHostNotice([NAME, "other"]);
		expect(line).toContain(NAME);
		expect(line).toContain("other");
		expect(line).toContain("Tailscale serve");
		expect(line).toContain("never a public tunnel");
		expect(line.toLowerCase()).not.toContain("funnel");
	});
});

describe("usertrust-ui arguments", () => {
	it("collects repeated --allow-host values and keeps them out of the root directory", () => {
		const r = parseUiArgs([
			"--allow-host",
			NAME,
			"--no-open",
			"--allow-host",
			"other",
			"--port",
			"4181",
			"/vault",
		]);
		expect(r).toEqual({
			ok: true,
			args: { noOpen: true, port: 4181, rootDir: "/vault", allowHosts: [NAME, "other"] },
		});
	});

	it("refuses to start, exit 2, on a wildcard, an invalid name or a missing value", () => {
		for (const argv of [
			["--allow-host", "*"],
			["--allow-host", "*.ts.net"],
			["--allow-host", "10.0.0.5"],
			["--allow-host", "dash:80"],
			["--allow-host"],
			["--allow-host", "--no-open"],
		]) {
			const r = parseUiArgs(argv);
			expect(r, argv.join(" ")).toMatchObject({ ok: false, code: 2 });
		}
	});

	it("keeps the old --port error and default shape", () => {
		expect(parseUiArgs(["--port", "x"])).toMatchObject({ ok: false, code: 1 });
		expect(parseUiArgs([])).toEqual({
			ok: true,
			args: { noOpen: false, port: undefined, rootDir: undefined, allowHosts: [] },
		});
	});
});
