// Drives the cursor lock's stale reclaim in one process, for transcript.test.ts:
// the race needs an interleaving that whole hook processes cannot be made to hit.
// Prints one JSON line.
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replaceStaleLock } from "../../hooks/transcript.mjs";

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

// Two reclaimers that judged the same stale lock at once: never two holders.
let bothWon = 0;
let noneWon = 0;
for (let round = 0; round < 50; round += 1) {
	await staleLock("dead");
	const [b, c] = await Promise.all([
		replaceStaleLock(lock, "B", "dead"),
		replaceStaleLock(lock, "C", "dead"),
	]);
	if (b && c) bothWon += 1;
	if (!b && !c) noneWon += 1;
}
process.stdout.write(JSON.stringify({ first, late, ownerAfterLate, bothWon, noneWon }));
