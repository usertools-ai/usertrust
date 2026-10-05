// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * A second process starting the runtime on a vault (1c-2, one process per vault): prints one
 * JSON line and exits 0 when it started; exits 3 when the vault's audit lock is held by another
 * live process; exits 1 on anything else.
 */

import { AuditWriterLockHeldError } from "usertrust";
import { startRuntime } from "../../src/runtime.js";
import { FakeLedger } from "./fake-ledger.js";

const [vaultPath, journalPath] = process.argv.slice(2);
try {
	const rt = await startRuntime({
		vaultPath: vaultPath as string,
		journalPath: journalPath as string,
		ledger: new FakeLedger(),
		engine: { holdTtlSeconds: 900 },
	});
	rt.close();
	console.log(JSON.stringify({ started: true }));
} catch (err) {
	console.log(JSON.stringify({ started: false, name: (err as Error).name }));
	process.exit(err instanceof AuditWriterLockHeldError ? 3 : 1);
}
