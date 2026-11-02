// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * `connectDeadline` and `preflightLedger` against a REAL TigerBeetle cluster.
 *
 * The unit suites (`connect-deadline.test.ts`, `preflight.test.ts`) replace the native client or the
 * network. This file proves the two cases that matter on the real binding:
 *  - a cluster that is running and formatted for this client answers within 2 s;
 *  - a cluster formatted with ANOTHER id accepts the connection (so the preflight passes) and never
 *    answers this client, which is exactly "something is listening but no usertrust ledger answered":
 *    the deadline stops it with that message, and closes the client so the process can exit.
 *
 * Self-skips when `USERTRUST_TB_ADDRESS` is unset, like every `.tb.test.ts`; the `tb-integration` job
 * sets it for the cluster it formats with `--cluster=0`.
 */

import { describe, expect, it } from "vitest";

const TB_ADDRESS = process.env.USERTRUST_TB_ADDRESS;

describe.skipIf(TB_ADDRESS === undefined)("connecting to a real cluster", () => {
	const address = TB_ADDRESS as string;

	it("a running cluster of this id answers the preflight and the deadline within 2 s", async () => {
		const { preflightLedger } = await import("../../src/ledger/preflight.js");
		const { TrustTBClient } = await import("../../src/ledger/client.js");
		const started = Date.now();
		await preflightLedger([address]);
		const client = new TrustTBClient({ addresses: [address], clusterId: 0n });
		try {
			await client.connectDeadline(5_000);
		} finally {
			await client.close();
		}
		// timing: 2 s bound on preflight plus the first answer from a local single-node cluster, which answers in tens of ms; the 5 s deadline passed to connectDeadline is the hard stop.
		expect(Date.now() - started).toBeLessThan(2_000);
	}, 20_000); // timing: 20 s test budget over the 2 s assertion above; a local single-node cluster answers in tens of ms.

	it("a cluster formatted with another id: the preflight passes, and the deadline says something is listening", async () => {
		const { preflightLedger } = await import("../../src/ledger/preflight.js");
		const { TrustTBClient } = await import("../../src/ledger/client.js");
		const { LedgerUnavailableError } = await import("../../src/shared/errors.js");
		// The cluster in this job is formatted with id 0; this client asks for id 1.
		await preflightLedger([address]);
		const client = new TrustTBClient({ addresses: [address], clusterId: 1n });
		const err = await client.connectDeadline(1_500).then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(LedgerUnavailableError);
		expect((err as Error).message).toContain("something is listening");
		expect((err as Error).message).toContain("npx usertrust tb status");
	}, 30_000); // timing: 30 s test budget over a 5 s connectDeadline plus close()'s 2 s probe wait (4x headroom).
});
