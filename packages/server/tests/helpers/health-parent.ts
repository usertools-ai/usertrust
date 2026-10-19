// Plays the server for the ledger health observer, aimed at `127.0.0.1:<port>`, and prints the
// child's pid. Run under source-preload.mjs: `node health-parent.ts <port> <mode>`.
//   hold      the REAL child (spawnHealthChild); stays alive until it is killed
//   return    the REAL child; returns from main with the observer still running, and nothing else
//             of its own left: it must exit by itself, the observer holding nothing open.
//   respawn   a fake child that exits at once, so the observer has a respawn timer pending with a
//             300 s cooldown; returns from main once that timer is armed: it must exit by itself.
//   notready  a fake child that never says ready, so the observer has its ready deadline pending
//             (ledgerTimeoutMs, 5 s); returns from main at once: it must exit by itself.
// The server API cannot drop its HTTP server and keep its health observer (only close() ends
// either, and it ends both), so this starts the observer alone, as listen() starts it.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { LedgerHealth, spawnHealthChild } from "../../src/ledger-health.js";

const [port, mode] = process.argv.slice(2);
const FAKE_CHILD = join(import.meta.dirname, "fake-health-child.mjs");
const fake = mode === "respawn" || mode === "notready";
// The fake child's own mode: it exits at once, or stays alive and never says ready.
const fakeMode = mode === "respawn" ? "exit" : "hang";
// While the fake child has not exited, hold this process open so the exit is seen; released once
// the observer has handled it, i.e. its respawn timer is pending.
let holder: NodeJS.Timeout | undefined;

const health = new LedgerHealth([{ clusterId: 0, addresses: [`127.0.0.1:${port}`] }], {
	ledgerTimeoutMs: 5_000,
	respawnCooldownMs: 300_000,
	spawnChild: (target) => {
		const child = fake
			? spawn(process.execPath, [FAKE_CHILD, fakeMode], {
					stdio: ["ignore", "ignore", "ignore", "ipc"],
				})
			: spawnHealthChild(target);
		process.stdout.write(`${child.pid}\n`);
		if (mode === "respawn") {
			holder = setInterval(() => {}, 60_000);
			// Registered before the observer's own exit listener, so release after it has run.
			child.once("exit", () => setImmediate(() => clearInterval(holder)));
		}
		return child;
	},
});
health.start();
if (mode === "hold") setInterval(() => {}, 60_000);
