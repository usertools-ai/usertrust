// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { trust } from "../../../src/govern.js";
// Run in its own process by ledger-fail-fast.test.ts:
//   node --import tsx fail-fast-child.mts <trust|governor|raw> <configPath> <vaultBase> [address]
// It points a governor at a ledger address where nothing listens and reports what happened as one
// JSON line on stdout: how long the call took and the error it ended with. `raw` is the control: the
// native client alone, with no preflight, which is what a governor did before this check existed.
import { createGovernor } from "../../../src/headless.js";
import { TrustTBClient } from "../../../src/ledger/client.js";

const [mode, configPath, vaultBase, address] = process.argv.slice(2) as [
	string,
	string,
	string,
	string | undefined,
];
// timing: elapsed time reported to the test, which bounds it at 1 s; a refused loopback connect takes about 1 ms.
const started = Date.now();
const report = (outcome: string, message = ""): void => {
	// timing: reports elapsed ms; the test bounds it at 1 s and a refused loopback connect took 0.6 s end to end.
	process.stdout.write(`${JSON.stringify({ outcome, ms: Date.now() - started, message })}\n`);
};

if (mode === "raw") {
	const client = new TrustTBClient({ addresses: [address ?? "127.0.0.1:1"] });
	const answered = await Promise.race([
		client.lookupAccounts([1n]).then(
			() => "answered",
			() => "failed",
		),
		// timing: the control waits 3 s, 3x the 1 s a failing governor is allowed; a native client against a refused port never answers at all.
		new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 3_000)),
	]);
	report(answered);
	// The native client holds the process open: end it ourselves.
	process.exit(0);
}

const anthropicShaped = { messages: { create: async () => ({}) } };
try {
	if (mode === "trust") {
		await trust(anthropicShaped, { configPath, vaultBase });
	} else {
		await createGovernor({ configPath, vaultBase });
	}
	report("resolved");
	process.exit(2);
} catch (err) {
	report("rejected", err instanceof Error ? err.message : String(err));
	process.exitCode = 1;
}
