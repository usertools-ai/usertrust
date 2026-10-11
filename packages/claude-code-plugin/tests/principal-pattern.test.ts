import { execFile } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { PRINCIPAL_FIELD_PATTERN } from "../../core/src/shared/principal.js";

const TRANSCRIPT = join(import.meta.dirname, "..", "hooks", "transcript.mjs");

describe("the plugin's principal-field rule is core's", () => {
	// The plugin sends unit/role only when they pass its PRINCIPAL_FIELD; the server
	// refuses a principal that fails core's PRINCIPAL_FIELD_PATTERN with a 400 — a gap
	// in watch mode and a BLOCK in enforce mode. A tightening on one side alone would
	// turn every attributed authorize into that 400, so the two are pinned together.
	it("PRINCIPAL_FIELD (hooks/transcript.mjs) is exactly PRINCIPAL_FIELD_PATTERN (core)", async () => {
		const { stdout } = await promisify(execFile)(process.execPath, [
			"--input-type=module",
			"-e",
			`const m = await import(${JSON.stringify(pathToFileURL(TRANSCRIPT).href)}); process.stdout.write(String(m.PRINCIPAL_FIELD));`,
		]);
		expect(stdout).toBe(String(PRINCIPAL_FIELD_PATTERN));
	});
});
