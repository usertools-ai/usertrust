import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { run } from "../../src/cli/tb.js";
import { DEFAULT_TIGERBEETLE_ADDRESS } from "../../src/shared/constants.js";

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
		expect(combined).toContain("does not manage TigerBeetle in this version");
	});

	it("start prints the format step, then a start on the governor's default address", async () => {
		process.argv = ["node", "usertrust", "tb", "start"];

		await run();

		const combined = logOutput.join("\n");
		const format = combined.indexOf(
			"tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development 0_0.tigerbeetle",
		);
		const start = combined.indexOf(
			`tigerbeetle start --addresses=${DEFAULT_TIGERBEETLE_ADDRESS} --development 0_0.tigerbeetle`,
		);
		expect(format).toBeGreaterThanOrEqual(0);
		expect(start).toBeGreaterThan(format);
		expect(DEFAULT_TIGERBEETLE_ADDRESS).toBe("127.0.0.1:3001");
		expect(combined).not.toContain("--addresses=3000");
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
