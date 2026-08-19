// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A governor built against an unreachable TigerBeetle must FAIL, not HANG.
 *
 * This suite drives the REAL native `tigerbeetle-node` client — it deliberately
 * does not mock it, because the defect being pinned lives in the client's own
 * retry behaviour and a mock cannot reproduce it. `tigerbeetle-node` exposes no
 * request timeout and treats an unreachable cluster as transient: it retries the
 * handshake forever and its promise never rejects. `createGovernor()` awaited that
 * promise, so with `dryRun: false` — the DEFAULT, and the only thing a real
 * deployment runs — it never returned at all. The `LedgerUnavailableError` the
 * call site is written to catch was unreachable in the one failure mode operators
 * actually hit: no cluster running.
 *
 * Downstream that hang was an outage, not a degradation: `usertrust-server`
 * awaits this inside `/v1/authorize`, and `usertrust-claude-code` calls that
 * endpoint from a PreToolUse hook which fails CLOSED, so every tool call stalled
 * to the hook's own timeout and was then denied (usertools-ai/usertrust#130).
 *
 * No cluster is required to run this: a CLOSED port reproduces it exactly, which
 * is why this lives in the normal test job rather than the env-gated
 * `.tb.test.ts` set. The healthy-cluster half of the contract — that the deadline
 * does not fire against a LIVE cluster — is covered by the `tb-integration` CI
 * job, which drives this same `createTBEngine` through
 * `tests/integration/tigerbeetle.tb.test.ts`.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGovernor } from "../../src/headless.js";
import { LedgerUnavailableError } from "../../src/shared/errors.js";

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

const CONNECT_TIMEOUT_MS = 400;

/**
 * Well above the deadline, so a REGRESSION reports as this test failing rather
 * than as the whole file timing out.
 */
const REGRESSION_CEILING_MS = 20_000;

async function vaultWithDeadCluster(): Promise<string> {
	const vaultBase = await mkdtemp(join(tmpdir(), "ut-connect-deadline-"));
	const configPath = join(vaultBase, "usertrust.config.json");
	await writeFile(
		configPath,
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: {
				addresses: [`127.0.0.1:${await closedPort()}`],
				connectTimeoutMs: CONNECT_TIMEOUT_MS,
			},
		}),
		"utf-8",
	);
	return configPath;
}

describe("ledger connect deadline — an unreachable TigerBeetle fails loud", () => {
	it(
		"rejects createGovernor with LedgerUnavailableError instead of hanging forever",
		async () => {
			const configPath = await vaultWithDeadCluster();
			const vaultBase = join(configPath, "..");

			const startedAt = Date.now();
			const settled = await createGovernor({ vaultBase, configPath, dryRun: false }).then(
				async (governor) => {
					// Must not happen — but never leak a live client if it does.
					await governor.destroy();
					return "resolved" as const;
				},
				(err: unknown) => err,
			);
			const elapsedMs = Date.now() - startedAt;

			expect(settled).toBeInstanceOf(LedgerUnavailableError);
			const err = settled as LedgerUnavailableError;
			// The operator has to be able to act on it: name the ledger and the way out.
			expect(err.message).toContain("Ledger unavailable");
			expect(err.message).toContain("dryRun");
			// The hint must name a command that WORKS — "npx usertrust tb start" is a stub.
			expect(err.message).not.toContain("usertrust tb start");
			// Pin the DEADLINE as the thing that ended it. Without this the assertion
			// above would also pass on a client that happened to reject on its own,
			// which is not the behaviour being guaranteed here.
			expect(err.cause_message).toContain(`within ${CONNECT_TIMEOUT_MS}ms`);
			// Generous ceiling: proves boundedness, not stopwatch accuracy.
			expect(elapsedMs).toBeLessThan(10_000);
		},
		REGRESSION_CEILING_MS,
	);
});
