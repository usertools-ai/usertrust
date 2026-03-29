// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * CLI: usertrust tb — TigerBeetle process management (stubs)
 *
 * v1 stubs: prints helpful setup messages. Future versions will
 * manage the embedded TigerBeetle process lifecycle.
 */

import pc from "picocolors";
import type { CliOptions } from "./init.js";

export async function run(opts?: CliOptions): Promise<void> {
	const subcommand = process.argv[3];
	const json = opts?.json === true;

	switch (subcommand) {
		case "start":
			if (json) {
				console.log(
					JSON.stringify({
						command: "tb",
						success: false,
						data: { action: "start", message: "Not yet implemented" },
					}),
				);
			} else {
				console.log(pc.yellow("TigerBeetle start — not yet implemented."));
				console.log("To run TigerBeetle manually:");
				console.log(
					pc.dim("  tigerbeetle start --addresses=3000 --cache-grid=256MiB ./data/0_0.tigerbeetle"),
				);
			}
			break;

		case "stop":
			if (json) {
				console.log(
					JSON.stringify({
						command: "tb",
						success: false,
						data: { action: "stop", message: "Not yet implemented" },
					}),
				);
			} else {
				console.log(pc.yellow("TigerBeetle stop — not yet implemented."));
				console.log("To stop TigerBeetle manually:");
				console.log(pc.dim("  kill $(pgrep tigerbeetle)"));
			}
			break;

		case "status": {
			let isRunning = false;
			try {
				const { execSync } = await import("node:child_process");
				const result = execSync("pgrep tigerbeetle", { encoding: "utf-8" }).trim();
				isRunning = result.length > 0;
			} catch {
				isRunning = false;
			}

			if (json) {
				console.log(
					JSON.stringify({
						command: "tb",
						success: true,
						data: { action: "status", running: isRunning },
					}),
				);
			} else if (isRunning) {
				console.log(`TigerBeetle: ${pc.green("running")}`);
			} else {
				console.log(`TigerBeetle: ${pc.dim("not running")}`);
			}
			break;
		}

		default:
			if (json) {
				console.log(
					JSON.stringify({
						command: "tb",
						success: false,
						data: { message: "Unknown subcommand. Use: start, stop, status" },
					}),
				);
			} else {
				console.log("Usage: usertrust tb <start|stop|status>");
			}
			break;
	}
}
