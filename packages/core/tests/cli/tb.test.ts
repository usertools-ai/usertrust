import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/tb.js";

describe("usertrust tb", () => {
	let logOutput: string[];
	let originalArgv: string[];

	beforeEach(() => {
		logOutput = [];
		originalArgv = [...process.argv];
		vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			logOutput.push(args.map(String).join(" "));
		});
	});

	afterEach(() => {
		process.argv = originalArgv;
		vi.restoreAllMocks();
	});

	it("prints usage when no subcommand given", async () => {
		process.argv = ["node", "usertrust", "tb"];

		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("Usage:");
	});

	it("prints stub message for start", async () => {
		process.argv = ["node", "usertrust", "tb", "start"];

		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("not yet implemented");
		expect(combined).toContain("tigerbeetle start");
	});

	it("prints stub message for stop", async () => {
		process.argv = ["node", "usertrust", "tb", "stop"];

		await run();

		const combined = logOutput.join("\n");
		expect(combined).toContain("not yet implemented");
	});

	it("reports status", async () => {
		process.argv = ["node", "usertrust", "tb", "status"];

		await run();

		const combined = logOutput.join("\n");
		// TB is not running in test environment
		expect(combined).toContain("TigerBeetle:");
	});
});
