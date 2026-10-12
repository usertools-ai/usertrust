// Samples a vault's `.env*` files while another process rewrites them:
// `node env-mode-sampler.mjs <vaultDir> <stopFile>`. Each sample opens ONE fd and reads the
// mode (fstat) and the content from that same fd, so the two always describe the same inode
// (a stat-then-read by path could pair one file's mode with another's bytes). Counts the
// samples where a group- or other-readable file holds a NEW key. Prints "ready", then, once
// `stopFile` exists, `{"samples":n,"exposed":n}`.
//
// It never outlives its test: it also stops when the vault is gone (the test's teardown removed
// it), and after a hard deadline it exits non-zero, so a test that never writes `stopFile` cannot
// leave it spinning.
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEADLINE_MS = 30_000;

const [vaultDir, stopFile] = process.argv.slice(2);
let samples = 0;
let exposed = 0;
const deadline = Date.now() + DEADLINE_MS;
process.stdout.write("ready\n");
while (!existsSync(stopFile)) {
	if (Date.now() > deadline) {
		process.stderr.write(`env-mode-sampler: no stop file after ${DEADLINE_MS} ms; exiting\n`);
		process.exit(2);
	}
	let names = [];
	try {
		names = readdirSync(vaultDir).filter((n) => n.startsWith(".env"));
	} catch (err) {
		if (err?.code === "ENOENT") break; // the vault is gone: nothing left to sample
		continue;
	}
	for (const name of names) {
		let fd;
		try {
			fd = openSync(join(vaultDir, name), "r");
			const st = fstatSync(fd);
			const text = readFileSync(fd, "utf-8");
			samples++;
			if ((st.mode & 0o077) !== 0 && text.includes("sk-ant-NEW-")) exposed++;
		} catch {
			// renamed or removed between readdir and open
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}
}
process.stdout.write(`${JSON.stringify({ samples, exposed })}\n`);
