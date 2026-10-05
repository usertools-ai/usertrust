// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `TrustTBClient.destroy()` must be TERMINAL — a destroyed client never comes back.
 *
 * The failure this pins is a teardown that resurrects what it tears down. Closing
 * the client makes `tigerbeetle-node` reject the in-flight request with "Client was
 * closed." — which is, by every ordinary measure, a connection error. `withReconnect`
 * classified it as one, built a FRESH client, and retried. So the caller that gave
 * up on an unreachable ledger, destroyed its client, and reported the outage was
 * left with a brand-new client retrying forever against the same dead cluster:
 * `AGENTS.md:118-123` says an undestroyed TigerBeetle client is exactly what keeps
 * the event loop from draining, so this is a process that cannot exit.
 *
 * Seen in the field before it was understood — a real server run logged
 * `[TB] Reconnection attempt 1/5` immediately after answering 503 for the ledger
 * being unreachable. Nothing had asked it to reconnect.
 *
 * Drives the REAL native client against a closed port; the defect lives in that
 * client's own error text and reconnect classification, so a mock cannot reproduce
 * it. No cluster required.
 */

import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { TrustTBClient } from "../../src/ledger/client.js";

/** A port nothing is listening on: bind an ephemeral port, then give it back. */
async function closedPort(): Promise<number> {
	const probe = createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const address = probe.address();
	if (address === null || typeof address === "string") {
		throw new Error("could not acquire an ephemeral port");
	}
	const { port } = address;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

describe("TrustTBClient.destroy() is terminal", () => {
	it("settles an in-flight request instead of reconnecting behind the caller", async () => {
		const client = new TrustTBClient({
			addresses: [`127.0.0.1:${await closedPort()}`],
			clusterId: 0n,
		});

		// Never resolves on its own: the client retries an unreachable cluster
		// forever and never rejects. destroy() has to be what ends it.
		const inFlight = client.createTreasury();
		setTimeout(() => client.destroy(), 300);

		const settled = await inFlight.then(
			() => "resolved" as const,
			(err: unknown) => err,
		);
		// The specific error does not matter; that it SETTLED does. An unfixed
		// client reconnects here and this await never returns.
		expect(settled).toBeInstanceOf(Error);
	}, 20_000); // rather than timing out the whole file. // Well above the 300ms teardown, so a regression fails this test by name

	it("refuses to reconnect once destroyed, even if asked directly", async () => {
		const client = new TrustTBClient({
			addresses: [`127.0.0.1:${await closedPort()}`],
			clusterId: 0n,
		});
		client.destroy();
		// Checked in reconnect() as well as in withReconnect, so no later caller can
		// reopen a destroyed client by a different route.
		await expect(client.reconnect()).rejects.toThrow(/destroyed/i);
	});
});
