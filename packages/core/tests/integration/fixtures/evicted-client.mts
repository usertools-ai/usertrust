// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Run in its OWN process by `evicted-client.tb.test.ts`, against a private TigerBeetle cluster:
 * `tsx evicted-client.mts <address> <cycles|control>`.
 *
 * `cycles` (a count): a TrustTBClient registers its session, then the cluster evicts it, once
 * per cycle. Sessions are registered ONE AT A TIME (each commits one request, then its client
 * is destroyed; a replica resets connections past its limit, so 64 held open never register),
 * until 64 newer sessions push the client's out. The client's next request must then be
 * answered, through a reconnect that drops the evicted native client: tigerbeetle-node 0.17.9
 * aborts the process (SIGABRT) on destroy() of an evicted client. Each cycle prints the
 * process's threads, open file descriptors and RSS.
 *
 * `control`: a reconnect of a HEALTHY client (destroy() of the old one), then a request.
 *
 * It never calls process.exit: the parent checks the process ENDS on its own once the
 * client is destroyed, so a dropped native client that kept the event loop alive would show
 * as a hang.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "tigerbeetle-node";
import { TrustTBClient } from "../../../src/ledger/client.js";

const [address = "", mode = "1"] = process.argv.slice(2);
const print = (line: Record<string, unknown>): void => {
	process.stdout.write(`${JSON.stringify(line)}\n`);
};

let reconnects = 0;
console.log = (...args: unknown[]) => {
	if (String(args[0]).includes("Reconnection attempt")) reconnects += 1;
};

const threads = (): number => {
	if (process.platform === "linux") {
		const status = readFileSync("/proc/self/status", "utf8");
		return Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? Number.NaN);
	}
	// macOS: one line per thread, after a header.
	return (
		execFileSync("ps", ["-M", "-p", String(process.pid)], { encoding: "utf8" })
			.trim()
			.split("\n").length - 1
	);
};
const fds = (): number =>
	readdirSync(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd").length;
const sample = () => ({ threads: threads(), fds: fds(), rss: process.memoryUsage().rss });
const gc = (globalThis as { gc?: () => void }).gc;

const target = new TrustTBClient({ addresses: [address], clusterId: 0n });
await target.lookupAccounts([1n]);
print({ step: "start", ...sample() });

if (mode === "control") {
	await target.reconnect();
	const answered = await target.lookupAccounts([1n]);
	print({ step: "control", answered: Array.isArray(answered), reconnects, ...sample() });
} else {
	for (let cycle = 1; cycle <= Number(mode); cycle++) {
		for (let i = 0; i < 64; i++) {
			const other = createClient({ cluster_id: 0n, replica_addresses: [address] });
			await other.lookupAccounts([]);
			other.destroy();
		}
		const before = reconnects;
		const answered = await target.lookupAccounts([1n]);
		gc?.();
		print({
			step: "cycle",
			cycle,
			answered: Array.isArray(answered),
			reconnected: reconnects - before,
			...sample(),
		});
	}
}

target.destroy();
gc?.();
// What still holds the event loop. The timer below does not: it fires only if something else
// (a native client left open) still does, and then reports it and ends the process.
print({ step: "end", active: process.getActiveResourcesInfo(), ...sample() });
setTimeout(() => {
	print({ step: "still-alive", ...sample() });
	process.exit(0);
}, 3_000).unref();
