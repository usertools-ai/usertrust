import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LEDGER_HOLD_TIMEOUT_MS } from "../../core/src/shared/constants.js";

const TRANSCRIPT = join(import.meta.dirname, "..", "hooks", "transcript.mjs");

describe("the journal reads a settle as abandoned only after the ledger has expired its hold", () => {
	// A `.settling` record older than STALE_SETTLING_MS is cleared without its hold
	// being given back. That strands nothing only while the ledger's own pending
	// timeout (core's LEDGER_HOLD_TIMEOUT_MS) is shorter: raising the timeout past the
	// staleness rule, or lowering the rule below it, would leave a live hold reserved
	// with no record of it. So the two are pinned together.
	it("STALE_SETTLING_MS (hooks/transcript.mjs) exceeds LEDGER_HOLD_TIMEOUT_MS (core)", async () => {
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(pathToFileURL(TRANSCRIPT).href)}); process.stdout.write(String(m.STALE_SETTLING_MS));`,
		]);
		expect(Number(stdout)).toBeGreaterThan(LEDGER_HOLD_TIMEOUT_MS);
	});
});
