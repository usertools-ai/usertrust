import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLedgerEvents } from "usertrust";
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
	/** The tenant's ledger address as written, when not `127.0.0.1:<ledgerPort>`. */
	address?: string;
	/** "absent": no vault config file; "no-budget": a file without `budget`. */
	vaultConfig?: "absent" | "no-budget";
	/** The tenant's own `budget` in the server config. */
	tenantBudget?: number;
}): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "utsrv-cli-"));
	const stateDir = join(dir, "state");
	const vault = join(stateDir, "acme", ".usertrust");
	await mkdir(vault, { recursive: true });
	if (opts.vaultConfig !== "absent") {
		await writeFile(
			join(vault, "usertrust.config.json"),
			JSON.stringify({
				...(opts.vaultConfig === "no-budget" ? {} : { budget: 50_000 }),
				tigerbeetle: {
					addresses: [opts.address ?? `127.0.0.1:${opts.ledgerPort}`],
					clusterId: 0,
				},
			}),
		);
	}
	const path = join(dir, "usertrust-server.config.json");
	await writeFile(
		path,
		JSON.stringify({
			host: "127.0.0.1",
			port: opts.port,
			stateDir,
			dryRun: opts.dryRun,
			ledgerProbeTimeoutMs: PROBE_TIMEOUT_MS,
			tenants: [
				{
					id: "acme",
					keyHash: hashKey("ut_cli_key"),
					...(opts.tenantBudget !== undefined ? { budget: opts.tenantBudget } : {}),
				},
			],
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

/** Runs the CLI until it exits or listens, at most SLACK_MS; what it printed, and how it ended. */
async function runUntilSettled(
	configPath: string,
): Promise<{ code: number | null; listened: boolean; stderr: string }> {
	const { proc, stderr } = startCli(configPath);
	return new Promise((resolve) => {
		const settle = (code: number | null) => {
			clearTimeout(timer);
			resolve({ code, listened: stderr().includes("listening on"), stderr: stderr() });
		};
		const timer = setTimeout(() => settle(null), SLACK_MS);
		proc.stderr?.on("data", () => {
			if (stderr().includes("listening on")) settle(null);
		});
		proc.once("exit", (code) => settle(code));
	});
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

	it("prints its refusal with escape sequences and control characters removed", async () => {
		const port = await freePort();
		const ledgerPort = await freePort();
		// A clear-screen sequence and an 8-bit CSI introducer, inside a configured value.
		const address = `127.0.0.1:${ledgerPort}\x1b[2J\u009b31mX`;
		const configPath = await writeServerConfig({ dryRun: false, port, ledgerPort, address });
		const { proc, stderr } = startCli(configPath);
		const code = await new Promise<number | null>((resolve) => proc.once("exit", resolve));

		expect(code).toBe(1);
		expect(stderr()).toContain("usertrust-server failed to start:");
		expect(stderr()).not.toContain("\x1b");
		expect(stderr()).not.toContain("\u009b");
		expect(stderr()).not.toContain("[2J");
	}, 40_000);

	it("refuses at start when a tenant's config file has no budget and the server gives none", async () => {
		const port = await freePort();
		const ledgerPort = await freePort();
		const configPath = await writeServerConfig({
			dryRun: false,
			port,
			ledgerPort,
			vaultConfig: "no-budget",
		});
		const { code, listened, stderr } = await runUntilSettled(configPath);
		expect(listened).toBe(false);
		expect(code).toBe(1);
		// createGovernor gives a config FILE no default budget: this tenant's first request
		// would fail. Named at start, not discovered by the probe's timeout.
		expect(stderr).toContain("tenant acme: cannot read its usertrust config");
		expect(stderr).toContain("has no budget");
		expect(stderr).not.toContain("no TigerBeetle answered");
	}, 40_000);

	it("control: the same file with a tenant budget gets past the config, to the ledger", async () => {
		const configPath = await writeServerConfig({
			dryRun: false,
			port: await freePort(),
			ledgerPort: await freePort(),
			vaultConfig: "no-budget",
			tenantBudget: 50_000,
		});
		const { stderr } = await runUntilSettled(configPath);
		expect(stderr).not.toContain("cannot read its usertrust config");
		// It reached the ledger probe: refused there (no TigerBeetle on that port, or none
		// usable on this host), never for its budget.
		expect(stderr).toContain("TigerBeetle");
	}, 40_000);

	it("control: an absent config file still gets the default budget", async () => {
		const configPath = await writeServerConfig({
			dryRun: false,
			port: await freePort(),
			ledgerPort: await freePort(),
			vaultConfig: "absent",
		});
		const { listened, stderr } = await runUntilSettled(configPath);
		expect(stderr).not.toContain("cannot read its usertrust config");
		// The default ledger address (127.0.0.1:3001): refused there, or started if a
		// TigerBeetle happens to listen on it.
		expect(listened || stderr.includes("TigerBeetle")).toBe(true);
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

describe("usertrust-server CLI: SIGTERM with a pending hold", () => {
	it("ends the hold, records it as 'server shutdown', and exits 0 inside the shutdown bound", async () => {
		const port = await freePort();
		const ledgerPort = await freePort();
		const configPath = await writeServerConfig({ dryRun: true, port, ledgerPort });
		const { proc, stderr } = startCli(configPath);
		const exit = new Promise<number | null>((resolve) => proc.once("exit", resolve));
		// Listening is the CLI's own line: handlers are installed before it, so a signal sent now
		// reaches the shutdown and never the default action.
		await new Promise<void>((resolve) => {
			if (stderr().includes("listening on")) return resolve();
			proc.stderr?.on("data", () => {
				if (stderr().includes("listening on")) resolve();
			});
			proc.once("exit", () => resolve());
		});
		expect(stderr()).toContain("listening on");
		const res = await fetch(`http://127.0.0.1:${port}/v1/authorize`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer ut_cli_key" },
			body: JSON.stringify({
				model: "claude-sonnet-4-6",
				estimatedInputTokens: 10,
				maxOutputTokens: 10,
			}),
		});
		expect(res.status).toBe(200);
		const { transferId } = (await res.json()) as { transferId: string };

		const signalled = Date.now();
		proc.kill("SIGTERM");
		const code = await exit;
		const took = Date.now() - signalled; // timing: shutdown bound 8000 ms; measured 30-40 ms in 3 runs on a loaded runner

		expect(code).toBe(0);
		expect(took).toBeLessThan(8_000); // timing: the bound is SHUTDOWN_BOUND_MS (8000); measured 30-40 ms
		const released = (
			readLedgerEvents(join(dirname(configPath), "state", "acme", ".usertrust")) as Array<{
				kind: string;
				data: Record<string, unknown>;
			}>
		).filter((e) => e.kind === "hold_released");
		// mutant: the governor's own SIGTERM listener is live too → it ends the hold first, as 'governor destroyed'
		expect(released.map((e) => [e.data.transferId, e.data.reason])).toEqual([
			[transferId, "server shutdown"],
		]);
	}, 60_000); // timing: test timeout 60000 ms; the test runs in 0.4-0.5 s, the rest is room for compiling the CLI's sources on a cold runner (SLACK_MS 20000)
});
