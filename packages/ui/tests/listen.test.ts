// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listenUi } from "../src/server/listen.js";
import { createUiServer, resolveProjectRoot, type UiServer } from "../src/server/server.js";

function inUse(): NodeJS.ErrnoException {
	return Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" });
}

describe("the project root at start", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "trust-ui-root-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("a root that does not exist fails the start with a message naming it, never a fallback", async () => {
		const missing = join(tempDir, "missing");
		const message = `the project root ${JSON.stringify(missing)} cannot be opened (ENOENT)`;
		expect(() => resolveProjectRoot(missing)).toThrow(message);
		await expect(createUiServer(missing, { port: 0 })).rejects.toThrow(message);
	});

	it("a root that is a file fails the start", async () => {
		const file = join(tempDir, "file");
		writeFileSync(file, "");
		await expect(createUiServer(file, { port: 0 })).rejects.toThrow(/is not a directory/);
	});

	it("the port search stops at a root error and reports it, not 'no free port'", async () => {
		const missing = join(tempDir, "missing");
		const tried: number[] = [];
		await expect(
			listenUi((port) => {
				tried.push(port);
				return createUiServer(missing, { port });
			}, undefined),
		).rejects.toThrow(`the project root ${JSON.stringify(missing)} cannot be opened (ENOENT)`);
		expect(tried).toEqual([4180]);
	});
});

describe("listenUi", () => {
	const fake = { port: 0 } as UiServer;

	it("moves past a port in use to the next", async () => {
		const tried: number[] = [];
		const ui = await listenUi(async (port) => {
			tried.push(port);
			if (port < 4182) throw inUse();
			return fake;
		}, undefined);
		expect(ui).toBe(fake);
		expect(tried).toEqual([4180, 4181, 4182]);
	});

	it("says no free port only when every port in the range is in use", async () => {
		const tried: number[] = [];
		await expect(
			listenUi(async (port) => {
				tried.push(port);
				throw inUse();
			}, undefined),
		).rejects.toThrow("no free port in 4180-4199; pass --port");
		expect(tried).toHaveLength(20);
	});

	it("rethrows any other error at once", async () => {
		const boom = new Error("boom");
		const tried: number[] = [];
		await expect(
			listenUi(async (port) => {
				tried.push(port);
				throw boom;
			}, undefined),
		).rejects.toBe(boom);
		expect(tried).toEqual([4180]);
	});

	it("an explicit port is tried once, and its error is the start's", async () => {
		const tried: number[] = [];
		await expect(
			listenUi(async (port) => {
				tried.push(port);
				throw inUse();
			}, 5000),
		).rejects.toThrow("listen EADDRINUSE");
		expect(tried).toEqual([5000]);
	});
});
