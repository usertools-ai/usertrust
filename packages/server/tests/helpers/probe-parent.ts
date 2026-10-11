// Plays the server for one probe child: spawns it the way probeLedger does, aimed at
// `127.0.0.1:<port>` with a `<timeoutMs>` deadline, prints the child's pid, and waits to
// be killed. Run under source-preload.mjs: `node probe-parent.ts <port> <timeoutMs>`.
import { spawnProbeChild } from "../../src/ledger-probe.js";

const [port, timeoutMs] = process.argv.slice(2);
const child = spawnProbeChild(
	{ clusterId: 0, addresses: [`127.0.0.1:${port}`] },
	Number(timeoutMs),
);
child.stderr?.resume();
process.stdout.write(`${child.pid}\n`);
setInterval(() => {}, 60_000);
