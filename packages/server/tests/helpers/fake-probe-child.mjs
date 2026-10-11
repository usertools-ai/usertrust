// A stand-in for cli/ledger-probe-child.ts that never loads tigerbeetle-node, so a test's
// outcome does not depend on the host (its io_uring, or a TigerBeetle that happens to be
// listening). `node fake-probe-child.mjs <mode>`:
//   sleep        never answers (the parent's deadline ends it)
//   ok:<ms>      answers after <ms>: exits 0
//   fail         crashes at once: exits 1 with a line on stderr
// Like the real child, it exits when its parent's IPC channel closes.
process.on("disconnect", () => process.exit(4));
const mode = process.argv[2] ?? "sleep";
if (mode === "fail") {
	process.stderr.write("fake probe child: crashed\n");
	process.exit(1);
} else if (mode.startsWith("ok:")) {
	setTimeout(() => process.exit(0), Number(mode.slice(3)));
} else {
	setInterval(() => {}, 60_000);
}
