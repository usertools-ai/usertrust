// Drives the cursor lock's stale reclaim in one process, for transcript.test.ts:
// the race needs an interleaving that whole hook processes cannot be made to hit.
// Prints one JSON line.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { replaceStaleLock } from "../../hooks/transcript.mjs";

const fsp = createRequire(import.meta.url)("node:fs/promises");
const { mkdir, readFile, rm, utimes, writeFile } = fsp;

const dir = process.argv[2];
const lock = join(dir, "cursor.json.lock");

async function staleLock(owner) {
	await rm(lock, { recursive: true, force: true });
	await mkdir(lock);
	await writeFile(join(lock, "owner"), owner);
	const old = new Date(Date.now() - 120_000);
	await utimes(lock, old, old);
}

// A late reclaimer: it judged the lock stale under its OLD owner, and acts only
// after another reclaimer has already replaced it.
await staleLock("dead");
const first = await replaceStaleLock(lock, "A", "dead");
const late = await replaceStaleLock(lock, "B", "dead");
const ownerAfterLate = await readFile(join(lock, "owner"), "utf-8");

// Two reclaimers that judged the same stale lock at once, in the one order that
// hurts: B's removal is slow, so C — checking the lock after B did — removes,
// recreates and owns it first, and B's removal then lands on C's live lock.
await staleLock("dead");
let removals = 0;
fsp.rm = async (...args) => {
	removals += 1;
	if (removals === 1) await new Promise((resolve) => setTimeout(resolve, 150));
	return rm(...args);
};
syncBuiltinESMExports();
const b = replaceStaleLock(lock, "B", "dead");
await new Promise((resolve) => setTimeout(resolve, 50));
const c = await replaceStaleLock(lock, "C", "dead");
const won = [await b, c];
fsp.rm = rm;
syncBuiltinESMExports();
const ownerAfterRace = await readFile(join(lock, "owner"), "utf-8");

process.stdout.write(JSON.stringify({ first, late, ownerAfterLate, won, ownerAfterRace }));
