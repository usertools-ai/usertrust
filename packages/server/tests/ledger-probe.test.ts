import { type ChildProcess, spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
// probeLedger from the package index: an embedder of createUsertrustServer calls it from there.
import { probeLedger } from "../src/index.js";
import { classifyLedgerProbe, resolveLedgerTargets, spawnProbeChild } from "../src/ledger-probe.js";

// Verbatim stderr of the native client panicking under Docker's default seccomp profile.
const IO_URING_PANIC = [
	"error(io): io_uring is not available",
	"error(io): likely cause: the syscall is disabled by sysctl, try 'sysctl -w kernel.io_uring_disabled=0'",
	"error(tb_client_context): …: failed to initialize IO: PermissionDenied",
	"thread 166 panic: attempt to unwrap error: PermissionDenied",
	"",
].join("\n");

const TARGET = { clusterId: 0, addresses: ["127.0.0.1:3001"] };

describe("classifyLedgerProbe", () => {
	it("exit 0 is OK", () => {
		expect(
			classifyLedgerProbe(
				{ exitCode: 0, signal: null, stderr: "", timedOut: false },
				TARGET,
				5_000,
			),
		).toEqual({ ok: true });
	});

	it("the io_uring panic names io_uring and both fixes", () => {
		const result = classifyLedgerProbe(
			{ exitCode: null, signal: "SIGABRT", stderr: IO_URING_PANIC, timedOut: false },
			TARGET,
			5_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe(
			"the TigerBeetle client cannot start here: io_uring is unavailable (blocked by the " +
				"container's seccomp profile or by kernel.io_uring_disabled). Either run where io_uring " +
				"is allowed (for Docker: --security-opt seccomp=unconfined, or a profile that allows " +
				"io_uring; on a host: sysctl kernel.io_uring_disabled=0) with TigerBeetle running, or " +
				'set "dryRun": true in the server config to try it without a ledger.',
		);
	});

	it("the io_uring panic is recognised after a non-zero exit too", () => {
		const result = classifyLedgerProbe(
			{ exitCode: 134, signal: null, stderr: IO_URING_PANIC, timedOut: false },
			TARGET,
			5_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("io_uring is unavailable");
	});

	it("a timeout names the addresses, the cluster and the timeout", () => {
		const result = classifyLedgerProbe(
			{ exitCode: null, signal: "SIGKILL", stderr: "", timedOut: true },
			{ clusterId: 7, addresses: ["127.0.0.1:3001", "127.0.0.1:3002"] },
			1_500,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toBe(
			"no TigerBeetle answered at 127.0.0.1:3001,127.0.0.1:3002 (cluster 7) within 1500 ms. " +
				'Start TigerBeetle 0.17.x on that address, or set "dryRun": true in the server config ' +
				"to try it without a ledger.",
		);
	});

	it("another crash quotes the child's stderr and gives both fixes", () => {
		const result = classifyLedgerProbe(
			{
				exitCode: 1,
				signal: null,
				stderr: "Error: Cannot find module 'tigerbeetle-node'\n",
				timedOut: false,
			},
			TARGET,
			5_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("127.0.0.1:3001 (cluster 0)");
		expect(result.message).toContain("exit code 1");
		expect(result.message).toContain("Error: Cannot find module 'tigerbeetle-node'");
		expect(result.message).toContain("Start TigerBeetle 0.17.x on that address");
		expect(result.message).toContain('"dryRun": true');
	});

	it("a crash by signal names the signal", () => {
		const result = classifyLedgerProbe(
			{ exitCode: null, signal: "SIGSEGV", stderr: "", timedOut: false },
			TARGET,
			5_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("signal SIGSEGV");
	});

	it("quotes at most ~2 KB of stderr, keeping the end", () => {
		const noise = Array.from({ length: 400 }, (_, i) => `line ${i} of noise`).join("\n");
		const result = classifyLedgerProbe(
			{ exitCode: 1, signal: null, stderr: `${noise}\nTHE LAST LINE\n`, timedOut: false },
			TARGET,
			5_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toContain("THE LAST LINE");
		expect(result.message).not.toContain("line 0 of noise");
		expect(result.message.length).toBeLessThan(2_600);
	});
});

function serverConfig(stateDir: string, overrides: Partial<ServerConfig> = {}): ServerConfig {
	return {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: false,
		tenants: [{ id: "a", keyHash: hashKey("key-a") }],
		...overrides,
	};
}

async function writeVaultConfig(dir: string, config: Record<string, unknown>): Promise<string> {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "usertrust.config.json");
	await writeFile(path, JSON.stringify(config));
	return path;
}

describe("resolveLedgerTargets", () => {
	it("a tenant without a vault config resolves to the core's default ledger address", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		expect(await resolveLedgerTargets(serverConfig(stateDir))).toEqual([
			{ clusterId: 0, addresses: ["127.0.0.1:3001"] },
		]);
	});

	it("reads each tenant's vault config, or its configPath, and dedupes identical ledgers", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		await writeVaultConfig(join(stateDir, "a", ".usertrust"), {
			budget: 100,
			tigerbeetle: { addresses: ["127.0.0.1:4001"], clusterId: 3 },
		});
		await writeVaultConfig(join(stateDir, "b", ".usertrust"), {
			budget: 100,
			tigerbeetle: { addresses: ["127.0.0.1:4001"], clusterId: 3 },
		});
		const elsewhere = await writeVaultConfig(join(stateDir, "elsewhere"), {
			// No budget in the file: the tenant's own budget fills it, as createGovernor does.
			tigerbeetle: { addresses: ["127.0.0.1:4002"] },
		});
		const targets = await resolveLedgerTargets(
			serverConfig(stateDir, {
				tenants: [
					{ id: "a", keyHash: hashKey("key-a") },
					{ id: "b", keyHash: hashKey("key-b") },
					{ id: "c", keyHash: hashKey("key-c"), budget: 50, configPath: elsewhere },
				],
			}),
		);
		expect(targets).toEqual([
			{ clusterId: 3, addresses: ["127.0.0.1:4001"] },
			{ clusterId: 0, addresses: ["127.0.0.1:4002"] },
		]);
	});

	it("a config file without a budget, and no tenant budget, fails as createGovernor would", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		// createGovernor supplies its default budget only when there is NO file.
		await writeVaultConfig(join(stateDir, "a", ".usertrust"), {
			tigerbeetle: { addresses: ["127.0.0.1:4001"] },
		});
		await expect(resolveLedgerTargets(serverConfig(stateDir))).rejects.toThrow(
			/tenant a: cannot read its usertrust config \(.*\): it has no budget/,
		);
	});

	it("an unreadable tenant config fails naming the tenant", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		const dir = join(stateDir, "a", ".usertrust");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "usertrust.config.json"), "{ not json");
		await expect(resolveLedgerTargets(serverConfig(stateDir))).rejects.toThrow(/tenant a/);
	});

	// The governor resolves a `..` in its base where the kernel does (createGovernor); the probe
	// must read the config from that same directory, or it probes a ledger the tenant never uses.
	describe.skipIf(process.platform === "win32")(
		"a stateDir with `..` after a symbolic link",
		() => {
			it("reads the tenant config the governor will read, at the kernel's location", async () => {
				const parent = await mkdtemp(join(tmpdir(), "utsrv-probe-dotdot-"));
				// `link -> <parent>/elsewhere/sub`, so the kernel reads `link/..` as `<parent>/elsewhere`.
				await mkdir(join(parent, "elsewhere", "sub"), { recursive: true });
				await symlink(join(parent, "elsewhere", "sub"), join(parent, "link"));
				const kernel = join(realpathSync.native(join(parent, "elsewhere")), "state");
				await writeVaultConfig(join(kernel, "a", ".usertrust"), {
					budget: 100,
					tigerbeetle: { addresses: ["127.0.0.1:4002"], clusterId: 2 },
				});
				// The lexical spelling of the same base, `<parent>/state`: a DIFFERENT ledger.
				await writeVaultConfig(join(parent, "state", "a", ".usertrust"), {
					budget: 100,
					tigerbeetle: { addresses: ["127.0.0.1:4001"], clusterId: 1 },
				});
				expect(await resolveLedgerTargets(serverConfig(`${parent}/link/../state`))).toEqual([
					{ clusterId: 2, addresses: ["127.0.0.1:4002"] },
				]);
			});

			it("refuses a `..` after a directory that does not exist, as the governor does", async () => {
				const parent = await mkdtemp(join(tmpdir(), "utsrv-probe-dotdot-"));
				const stateDir = `${parent}/missing/../state`;
				await expect(resolveLedgerTargets(serverConfig(stateDir))).rejects.toThrow(
					`tenant a: usertrust: the vault base ${stateDir}/a has ".." after ${parent}/missing, which does not exist yet; create it first, or give the base without ".."`,
				);
			});
		},
	);
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

const FAKE_CHILD = join(import.meta.dirname, "helpers", "fake-probe-child.mjs");

/** A spawner that starts fake-probe-child.mjs in `mode`, counting the children it starts. */
function fakeChild(mode: string) {
	let spawned = 0;
	let live = 0;
	let maxLive = 0;
	const spawnChild = (): ChildProcess => {
		const child = spawn(process.execPath, [FAKE_CHILD, mode], {
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		spawned += 1;
		live += 1;
		maxLive = Math.max(maxLive, live);
		child.once("exit", () => {
			live -= 1;
		});
		return child;
	};
	return { spawnChild, spawned: () => spawned, maxLive: () => maxLive };
}

/** A non-dryRun config whose three tenants each use a different ledger. */
async function threeLedgers(): Promise<ServerConfig> {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
	const ids = ["a", "b", "c"];
	for (const [i, id] of ids.entries()) {
		await writeVaultConfig(join(stateDir, id, ".usertrust"), {
			budget: 100,
			tigerbeetle: { addresses: [`127.0.0.1:${4101 + i}`] },
		});
	}
	return serverConfig(stateDir, {
		ledgerProbeTimeoutMs: 5_000,
		tenants: ids.map((id) => ({ id, keyHash: hashKey(`key-${id}`) })),
	});
}

describe("probeLedger", () => {
	it("refuses, naming the address, when no TigerBeetle answers in time", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		await writeVaultConfig(join(stateDir, "a", ".usertrust"), {
			budget: 100,
			tigerbeetle: { addresses: ["127.0.0.1:4100"] },
		});
		// A child that never answers: the outcome is the parent's deadline on any host.
		await expect(
			probeLedger(serverConfig(stateDir, { ledgerProbeTimeoutMs: 1_000 }), {
				spawnChild: fakeChild("sleep").spawnChild,
			}),
		).rejects.toThrow("no TigerBeetle answered at 127.0.0.1:4100 (cluster 0) within 1000 ms");
	}, 30_000);

	it("throws the raw message: sanitizing is the printer's job", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		const address = "127.0.0.1:4100\x1b[2J\u009b31m";
		await writeVaultConfig(join(stateDir, "a", ".usertrust"), {
			budget: 100,
			tigerbeetle: { addresses: [address] },
		});
		await expect(
			probeLedger(serverConfig(stateDir, { ledgerProbeTimeoutMs: 1_000 }), {
				spawnChild: fakeChild("sleep").spawnChild,
			}),
		).rejects.toThrow(`no TigerBeetle answered at ${address} (cluster 0)`);
	}, 30_000);

	it("probes one ledger at a time, and still reports every refusal", async () => {
		const config = await threeLedgers();
		const ok = fakeChild("ok:150");
		await probeLedger(config, { spawnChild: ok.spawnChild });
		expect(ok.spawned()).toBe(3);
		expect(ok.maxLive()).toBe(1);

		const failing = fakeChild("fail");
		const refusal = await probeLedger(config, { spawnChild: failing.spawnChild }).then(
			() => null,
			(err: Error) => err.message,
		);
		expect(failing.maxLive()).toBe(1);
		for (const port of [4101, 4102, 4103]) expect(refusal).toContain(`127.0.0.1:${port}`);
	}, 30_000);

	it("is single-flight: concurrent calls share one set of children", async () => {
		const config = await threeLedgers();
		const ok = fakeChild("ok:150");
		await Promise.all([
			probeLedger(config, { spawnChild: ok.spawnChild }),
			probeLedger(config, { spawnChild: ok.spawnChild }),
		]);
		expect(ok.spawned()).toBe(3);
		// Settled, it is not cached: a later call probes again.
		await probeLedger(config, { spawnChild: ok.spawnChild });
		expect(ok.spawned()).toBe(6);
	}, 30_000);

	it("a dryRun server needs no ledger and does not probe", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-probe-"));
		// A config the resolver would refuse proves nothing was read, let alone spawned.
		const dir = join(stateDir, "a", ".usertrust");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "usertrust.config.json"), "{ not json");
		await expect(probeLedger(serverConfig(stateDir, { dryRun: true }))).resolves.toBeUndefined();
	});
});

const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
const PROBE_PARENT = join(import.meta.dirname, "helpers", "probe-parent.ts");

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Polls until `pid` is gone, for at most `ms`; true if it went. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (!alive(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return !alive(pid);
}

describe("the probe child never outlives what started it", () => {
	const savedNodeOptions = process.env.NODE_OPTIONS;
	const leftovers: number[] = [];
	afterEach(() => {
		if (savedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
		else process.env.NODE_OPTIONS = savedNodeOptions;
		// A red run must not leak the very process it caught.
		for (const pid of leftovers.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
	});

	it("exits when its parent is killed mid-probe", async () => {
		const ledgerPort = await freePort();
		const parent = spawn(process.execPath, [PROBE_PARENT, String(ledgerPort), "30000"], {
			env: {
				...process.env,
				NODE_OPTIONS: `${savedNodeOptions ?? ""} --import "${PRELOAD}"`.trim(),
			},
			stdio: ["ignore", "pipe", "inherit"],
		});
		if (parent.pid !== undefined) leftovers.push(parent.pid);
		const childPid = await new Promise<number>((resolve, reject) => {
			let out = "";
			parent.stdout.setEncoding("utf-8");
			parent.stdout.on("data", (chunk: string) => {
				out += chunk;
				const line = out.split("\n")[0];
				if (out.includes("\n") && line !== undefined) resolve(Number(line));
			});
			parent.once("exit", () => reject(new Error("the parent exited before its child started")));
		});
		leftovers.push(childPid);
		// Let the child get well into its probe: booted, client created, retrying.
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		expect(alive(childPid)).toBe(true);

		parent.kill("SIGKILL");
		expect(await goneWithin(childPid, 2_000)).toBe(true);
	}, 30_000);

	it("keeps its own deadline: exits non-zero under a parent that never kills it", async () => {
		process.env.NODE_OPTIONS = `${savedNodeOptions ?? ""} --import "${PRELOAD}"`.trim();
		const target = { clusterId: 0, addresses: [`127.0.0.1:${await freePort()}`] };
		const started = Date.now();
		const child = spawnProbeChild(target, 1_000);
		if (child.pid !== undefined) leftovers.push(child.pid);
		let stderr = "";
		child.stderr?.setEncoding("utf-8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		const ended = await new Promise<{ code: number | null; signal: NodeJS.Signals | null } | null>(
			(resolve) => {
				const timer = setTimeout(() => resolve(null), 5_000);
				child.once("exit", (code, signal) => {
					clearTimeout(timer);
					resolve({ code, signal });
				});
			},
		);
		const elapsed = Date.now() - started;

		expect(ended, "the child was still running 5 s after a 1 s deadline").not.toBeNull();
		expect(ended?.code).not.toBe(0);
		expect(elapsed).toBeLessThan(2_500);
		// Its own deadline reads as the timeout refusal, exactly as the parent's kill does.
		const result = classifyLedgerProbe(
			{ exitCode: ended?.code ?? null, signal: ended?.signal ?? null, stderr, timedOut: false },
			target,
			1_000,
		);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.message).toMatch(/^no TigerBeetle answered at /);
	}, 30_000);
});
