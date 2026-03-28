/**
 * CLI: usertrust tb — TigerBeetle process management (stubs)
 *
 * v1 stubs: prints helpful setup messages. Future versions will
 * manage the embedded TigerBeetle process lifecycle.
 */

export async function run(): Promise<void> {
	const subcommand = process.argv[3];

	switch (subcommand) {
		case "start":
			console.log("TigerBeetle start — not yet implemented.");
			console.log("To run TigerBeetle manually:");
			console.log(
				"  tigerbeetle start --addresses=3000 --cache-grid=256MiB ./data/0_0.tigerbeetle",
			);
			break;

		case "stop":
			console.log("TigerBeetle stop — not yet implemented.");
			console.log("To stop TigerBeetle manually:");
			console.log("  kill $(pgrep tigerbeetle)");
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

			if (isRunning) {
				console.log("TigerBeetle: running");
			} else {
				console.log("TigerBeetle: not running");
			}
			break;
		}

		default:
			console.log("Usage: usertrust tb <start|stop|status>");
			break;
	}
}
