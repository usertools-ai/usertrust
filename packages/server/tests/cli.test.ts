import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashKey } from "../src/config.js";

// The CLI runs from its TypeScript sources: the preload compiles them and resolves
// `usertrust` to the core's sources, so no package needs building first. It rides
// NODE_OPTIONS, so the ledger probe's own child process gets it too.
const CLI = join(import.meta.dirname, "..", "src", "cli", "main.ts");
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");

const PROBE_TIMEOUT_MS = 1_000;
/** Covers compiling the sources on a cold CI runner, twice (the CLI, then the probe). */
const SLACK_MS = 20_000;

let child: ChildProcess | undefined;
afterEach(() => {
	child?.kill("SIGKILL");
	child = undefined;
});

/** A localhost port nothing listens on: bound by the OS, then released. */
async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

function accepts(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1");
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

/** A server config with one tenant whose vault config points its ledger at `ledgerPort`. */
async function writeServerConfig(opts: {
	dryRun: boolean;
	port: number;
	ledgerPort: number;
}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "utsrv-cli-"));
	const stateDir = join(dir, "state");
	const vault = join(stateDir, "acme", ".usertrust");
	await mkdir(vault, { recursive: true });
	await writeFile(
		join(vault, "usertrust.config.json"),
		JSON.stringify({
			budget: 50_000,
			tigerbeetle: { addresses: [`127.0.0.1:${opts.ledgerPort}`], clusterId: 0 },
		}),
	);
	const path = join(dir, "usertrust-server.config.json");
	await writeFile(
		path,
		JSON.stringify({
			host: "127.0.0.1",
			port: opts.port,
			stateDir,
			dryRun: opts.dryRun,
			ledgerProbeTimeoutMs: PROBE_TIMEOUT_MS,
			tenants: [{ id: "acme", keyHash: hashKey("ut_cli_key") }],
		}),
	);
	return path;
}

function startCli(configPath: string): { proc: ChildProcess; stderr: () => string } {
	let stderr = "";
	const proc = spawn(process.execPath, [CLI, "--config", configPath], {
		env: {
			...process.env,
			NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import "${PRELOAD}"`.trim(),
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	proc.stderr?.setEncoding("utf-8");
	proc.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	child = proc;
	return { proc, stderr: () => stderr };
}

describe("usertrust-server CLI: ledger probe at start", () => {
	it("refuses to start, and never listens, when no TigerBeetle answers", async () => {
		const port = await freePort();
		const ledgerPort = await freePort();
		const configPath = await writeServerConfig({ dryRun: false, port, ledgerPort });
		const started = Date.now();
		const { proc, stderr } = startCli(configPath);

		let exited = false;
		const exit = new Promise<number | null>((resolve) => {
			proc.once("exit", (code) => {
				exited = true;
				resolve(code);
			});
		});
		// Watch the server port the whole time the process is alive.
		let everListened = false;
		const watch = (async () => {
			while (!exited) {
				if (await accepts(port)) everListened = true;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
		})();
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<"deadline">((resolve) => {
			timer = setTimeout(() => resolve("deadline"), PROBE_TIMEOUT_MS + SLACK_MS);
		});

		const code = await Promise.race([exit, deadline]);
		clearTimeout(timer);
		exited = true;
		await watch;

		expect(code).not.toBe("deadline");
		expect(code).not.toBe(0);
		expect(Date.now() - started).toBeLessThan(PROBE_TIMEOUT_MS + SLACK_MS);
		expect(stderr()).toContain("no TigerBeetle answered");
		expect(stderr()).toContain(`127.0.0.1:${ledgerPort}`);
		expect(stderr()).toContain("dryRun");
		expect(stderr()).not.toContain("listening on");
		expect(everListened).toBe(false);
	}, 40_000);

	it("a dryRun server does not probe: it starts and answers /v1/health", async () => {
		const port = await freePort();
		const ledgerPort = await freePort();
		const configPath = await writeServerConfig({ dryRun: true, port, ledgerPort });
		const { proc, stderr } = startCli(configPath);

		const ready = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), SLACK_MS);
			proc.stderr?.on("data", () => {
				if (stderr().includes("listening on")) {
					clearTimeout(timer);
					resolve(true);
				}
			});
			proc.once("exit", () => {
				clearTimeout(timer);
				resolve(false);
			});
		});
		expect(ready, stderr()).toBe(true);

		const res = await fetch(`http://127.0.0.1:${port}/v1/health`);
		expect(res.status).toBe(200);
	}, 40_000);
});
