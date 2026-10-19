// A stand-in for cli/ledger-health-child.ts that never loads tigerbeetle-node, so a test's
// outcome does not depend on the host. It speaks the same IPC: `{ ready }` once started, then
// `{ reply: n }` / `{ error: n, code }` per `{ probe: n }`. `node fake-health-child.mjs <mode>`:
//   reply         answers every probe at once
//   silent        never answers (the parent's deadline makes it unreachable)
//   error         answers every probe with an error
//   exit          exits 1 at once, before it is ready
//   hang          stays alive, never ready (a native load that hangs)
//   abort         aborts at once (a native panic's signal)
//   evict         on its first probe, says it was evicted and exits 5
//   delayed:<readyMs>:<replyMs|never>
//                 says ready after <readyMs> (a slow start), then answers each probe <replyMs>
//                 after it arrives, or never
//   file:<path>   answers a probe once <path> does not read "down" (a ledger that stops and returns)
// Like the real child, it exits when its parent's IPC channel closes or it is re-parented.
import { readFileSync } from "node:fs";

if (!process.connected) process.exit(4);
process.on("disconnect", () => process.exit(4));
const parentPid = process.ppid;
setInterval(() => {
	if (process.ppid !== parentPid) process.exit(4);
}, 250).unref();

const mode = process.argv[2] ?? "reply";
if (mode === "exit") process.exit(1);
if (mode === "abort") process.abort();
if (mode === "hang") setInterval(() => {}, 60_000);

const send = (message) => {
	if (process.connected) process.send(message);
};

function down(path) {
	try {
		return readFileSync(path, "utf-8").trim() === "down";
	} catch {
		return false;
	}
}

process.on("message", (message) => {
	const n = message?.probe;
	if (typeof n !== "number") return;
	if (mode === "reply") send({ reply: n });
	else if (mode.startsWith("delayed:")) {
		const replyMs = mode.split(":")[2];
		if (replyMs !== "never") setTimeout(() => send({ reply: n }), Number(replyMs));
	} else if (mode === "error") send({ error: n, code: "ERR_FAKE" });
	else if (mode === "evict") {
		send({ evicted: true });
		process.exit(5);
	} else if (mode.startsWith("file:")) {
		const path = mode.slice(5);
		const answer = setInterval(() => {
			if (down(path)) return;
			clearInterval(answer);
			send({ reply: n });
		}, 20);
	}
	// silent: never answers.
});
if (mode.startsWith("delayed:"))
	setTimeout(() => send({ ready: true }), Number(mode.split(":")[1]));
else if (mode !== "hang") send({ ready: true });
