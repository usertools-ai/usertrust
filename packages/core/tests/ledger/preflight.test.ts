// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `preflightLedger`: a plain TCP check, before any native client exists, that tells a ledger which
 * is not running from one that is. It passes when ANY configured address accepts a connection.
 */

import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { isLoopbackHost, parseLedgerAddress, preflightLedger } from "../../src/ledger/preflight.js";
import { LedgerUnavailableError } from "../../src/shared/errors.js";

const servers: Server[] = [];

/** A TCP listener on an ephemeral loopback port. */
async function listen(): Promise<number> {
	const server = createServer((socket) => socket.destroy());
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

/** A loopback port nothing listens on: bound, read, and closed again. */
async function unusedPort(): Promise<number> {
	const port = await listen();
	const server = servers.pop() as Server;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

afterEach(async () => {
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

describe("parseLedgerAddress", () => {
	it("reads a bare port as loopback", () => {
		expect(parseLedgerAddress("3000")).toEqual({ host: "127.0.0.1", port: 3000 });
	});

	it("reads host:port", () => {
		expect(parseLedgerAddress("127.0.0.1:3001")).toEqual({ host: "127.0.0.1", port: 3001 });
		expect(parseLedgerAddress("ledger.internal:4000")).toEqual({
			host: "ledger.internal",
			port: 4000,
		});
	});

	it("reads [v6]:port", () => {
		expect(parseLedgerAddress("[::1]:3001")).toEqual({ host: "::1", port: 3001 });
	});

	it("does not read what it does not know", () => {
		for (const bad of ["", "host", "host:", ":3001", "0", "70000", "a:b:c", "[::1]", "[::1]:x"]) {
			expect(parseLedgerAddress(bad), bad).toBeUndefined();
		}
	});

	it("calls loopback hosts loopback", () => {
		for (const host of ["127.0.0.1", "127.1.2.3", "::1", "localhost"])
			expect(isLoopbackHost(host)).toBe(true);
		for (const host of ["10.0.0.5", "ledger.internal", "::2"])
			expect(isLoopbackHost(host)).toBe(false);
	});
});

describe("preflightLedger", () => {
	it("passes when the address accepts a connection", async () => {
		const port = await listen();
		await expect(preflightLedger([`127.0.0.1:${port}`])).resolves.toBeUndefined();
	});

	it("given one refused address and one listening address, passes", async () => {
		const down = await unusedPort();
		const up = await listen();
		await expect(
			preflightLedger([`127.0.0.1:${down}`, `127.0.0.1:${up}`]),
		).resolves.toBeUndefined();
	});

	it("fails in milliseconds when every address refuses, and names the fix", async () => {
		const down = await unusedPort();
		const started = Date.now();
		const err = await preflightLedger([`127.0.0.1:${down}`]).then(
			() => undefined,
			(e: unknown) => e,
		);
		// timing: 1 s bound; a refused loopback connection answers in about 1 ms (measured 2 ms on a 14-core host, 5 runs), so the headroom is over 100x.
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		const message = (err as Error).message;
		expect(message).toContain(`No ledger is running at 127.0.0.1:${down}.`);
		expect(message).toContain("Fix: npx usertrust tb start");
		expect((err as LedgerUnavailableError).hint).toContain("npx usertrust tb start");
	});

	it("for an explicit non-loopback address, the fix names the address and the configured cluster", async () => {
		// 192.0.2.0/24 is TEST-NET-1: never routed, so the attempt ends at attemptMs.
		const err = await preflightLedger(["192.0.2.1:3001"], { clusterId: 7, attemptMs: 50 }).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		const message = (err as Error).message;
		expect(message).toContain("No ledger is running at 192.0.2.1:3001.");
		expect(message).toContain("cluster 7");
		expect(message).not.toContain("npx usertrust tb start");
	});

	it("does not judge an address it cannot read: the native client is the judge", async () => {
		await expect(preflightLedger(["not an address"])).resolves.toBeUndefined();
	});

	it("passes with no addresses at all", async () => {
		await expect(preflightLedger([])).resolves.toBeUndefined();
	});
});
