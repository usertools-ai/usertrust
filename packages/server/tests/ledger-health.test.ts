// The ledger health observer (ledger-health.ts) and what /v1/health and /v1/budget report from
// it. Most rows run a fake child (helpers/fake-health-child.mjs) that speaks the real child's IPC
// without loading tigerbeetle-node; the orphan and natural-exit rows run the real child.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Governor } from "usertrust";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config.js";
import { hashKey } from "../src/config.js";
import { type HealthChildSpawner, LedgerHealth, targetKey } from "../src/ledger-health.js";
import { resolveTenantTargets } from "../src/ledger-probe.js";
import { createUsertrustServer, type UsertrustServer } from "../src/server.js";
import { createFakeGovernor } from "./helpers/fake-governor.js";

const KEY = "ut_health_key";
const DEADLINE_MS = 600;
const FAKE_CHILD = join(import.meta.dirname, "helpers", "fake-health-child.mjs");
const PRELOAD = join(import.meta.dirname, "helpers", "source-preload.mjs");
const HEALTH_PARENT = join(import.meta.dirname, "helpers", "health-parent.ts");
const SRC = join(import.meta.dirname, "..", "src");
const TARGET = { clusterId: 0, addresses: ["127.0.0.1:1"] };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
		await sleep(50);
	}
	return !alive(pid);
}

/** Polls `read` until `done` holds of it, for at most `ms`; the last reading either way. */
async function until<T>(read: () => Promise<T> | T, done: (value: T) => boolean, ms = 5_000) {
	const deadline = Date.now() + ms;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await sleep(25);
		value = await read();
	}
	return value;
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	if (address === null || typeof address === "string") throw new Error("no port");
	return address.port;
}

/** Every pid a spawner started, across a test: killed after it, so a red run leaks nothing. */
const started: number[] = [];

interface Spawner {
	spawnChild: HealthChildSpawner;
	spawned(): number;
	/** When each child was started (performance.now()). */
	times: number[];
	pids: number[];
	/** How many probes were sent, over every child. */
	probes(): number;
}

/** A spawner that starts fake-health-child.mjs in `mode` (read at each spawn), counting. */
function fakeSpawner(mode: string | (() => string)): Spawner {
	const times: number[] = [];
	const pids: number[] = [];
	let probes = 0;
	const spawnChild: HealthChildSpawner = () => {
		times.push(performance.now());
		const child = spawn(process.execPath, [FAKE_CHILD, typeof mode === "string" ? mode : mode()], {
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		if (child.pid !== undefined) {
			pids.push(child.pid);
			started.push(child.pid);
		}
		const send = child.send.bind(child) as (...args: unknown[]) => boolean;
		child.send = ((...args: unknown[]) => {
			probes += 1;
			return send(...args);
		}) as ChildProcess["send"];
		return child;
	};
	return { spawnChild, spawned: () => times.length, times, pids, probes: () => probes };
}

const servers: UsertrustServer[] = [];
let stderr: string[] = [];

beforeEach(() => {
	stderr = [];
	const write = process.stderr.write.bind(process.stderr);
	vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
		stderr.push(String(chunk));
		return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
	}) as typeof process.stderr.write);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const server of servers.splice(0)) await server.close();
	for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

interface Started {
	server: UsertrustServer;
	base: string;
	config: ServerConfig;
}

/**
 * A server whose governor reports the ledger it read from the tenant's config when it was created,
 * as a real governor's `config.tigerbeetle` does. `gate`, when given, holds the creation open.
 */
async function start(
	opts: {
		spawner?: Spawner;
		overrides?: Partial<ServerConfig>;
		gate?: Promise<void>;
		/** The tenant's config file, written before the server starts. */
		file?: Record<string, unknown>;
		/** Leave `ledgerHealth` unset, as an embedder who never heard of it does. */
		unset?: boolean;
		/** The server's log sink. */
		log?: (line: string) => void;
		/** The health child's keep-alive probe interval; unset is the server's default (30 s). */
		healthKeepAliveMs?: number;
		/** The fake governor's `release` resolves this long after it starts (a slow shutdown). */
		releaseDelayMs?: number;
	} = {},
): Promise<Started> {
	const stateDir = await mkdtemp(join(tmpdir(), "utsrv-health-"));
	const configPath = join(stateDir, "tenant.config.json");
	if (opts.file !== undefined) await writeFile(configPath, JSON.stringify(opts.file));
	const config: ServerConfig = {
		host: "127.0.0.1",
		port: 0,
		stateDir,
		enforcement: "enforce",
		pendingTtlMs: 300_000,
		dryRun: false,
		ledgerTimeoutMs: DEADLINE_MS,
		ledgerHealth: "child",
		tenants: [
			{
				id: "acme",
				keyHash: hashKey(KEY),
				budget: 1_000_000,
				...(opts.file !== undefined ? { configPath } : {}),
			},
		],
		...opts.overrides,
	};
	if (opts.unset === true) delete config.ledgerHealth;
	const server = createUsertrustServer({
		config,
		factory: async (governorOpts) => {
			// The ledger THIS tenant's config names now (found by its configPath; "acme" when it has none).
			const id = config.tenants.find((t) => t.configPath === governorOpts.configPath)?.id ?? "acme";
			const used = (await resolveTenantTargets(config)).get(id);
			await opts.gate;
			const { governor } = createFakeGovernor(
				opts.releaseDelayMs !== undefined ? { releaseDelayMs: opts.releaseDelayMs } : {},
			);
			return { ...governor, config: { tigerbeetle: used } } as unknown as Governor;
		},
		...(opts.spawner !== undefined ? { spawnHealthChild: opts.spawner.spawnChild } : {}),
		...(opts.log !== undefined ? { log: opts.log } : {}),
		...(opts.healthKeepAliveMs !== undefined ? { healthKeepAliveMs: opts.healthKeepAliveMs } : {}),
	});
	servers.push(server);
	const { port } = await server.listen();
	return { server, base: `http://127.0.0.1:${port}`, config };
}

async function health(base: string) {
	const res = await fetch(`${base}/v1/health`);
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function budget(base: string) {
	const res = await fetch(`${base}/v1/budget`, { headers: { authorization: `Bearer ${KEY}` } });
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const ledgerOf = async (base: string) => (await health(base)).body.ledger;

/** The capabilities a server with no health at all publishes: health must not change them. */
async function plainCapabilities(): Promise<unknown> {
	const { base } = await start({ overrides: { ledgerHealth: "off" } });
	return (await health(base)).body.capabilities;
}

describe("which servers run a health child", () => {
	it("a programmatic server starts none unless asked: ledger unknown, ok true", async () => {
		const spawner = fakeSpawner("reply");
		const { base } = await start({ spawner, unset: true });
		await sleep(300);
		expect((await health(base)).body).toMatchObject({ ok: true, ledger: "unknown" });
		expect((await budget(base)).body).toMatchObject({
			ledger: "unknown",
			ledgerObserver: { failures: 0, lastFailure: null },
		});
		expect(spawner.spawned()).toBe(0);
	});

	it("dryRun: ledger none, and no child", async () => {
		const spawner = fakeSpawner("reply");
		const { base } = await start({ spawner, overrides: { dryRun: true } });
		await sleep(300);
		expect((await health(base)).body).toMatchObject({ ok: true, ledger: "none" });
		expect((await budget(base)).body.ledger).toBe("none");
		expect(spawner.spawned()).toBe(0);
	});

	it("no child before listen(): createUsertrustServer alone starts nothing", async () => {
		const spawner = fakeSpawner("reply");
		createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port: 0,
				stateDir: await mkdtemp(join(tmpdir(), "utsrv-health-")),
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: false,
				ledgerHealth: "child",
				tenants: [{ id: "acme", keyHash: hashKey(KEY) }],
			},
			spawnHealthChild: spawner.spawnChild,
		});
		await sleep(300);
		expect(spawner.spawned()).toBe(0);
	});

	it("one child per distinct target: two tenants on one ledger share it", async () => {
		const spawner = fakeSpawner("reply");
		const { base } = await start({
			spawner,
			overrides: {
				tenants: [
					{ id: "acme", keyHash: hashKey(KEY), budget: 1 },
					{ id: "beta", keyHash: hashKey("other"), budget: 1 },
				],
			},
		});
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		expect(spawner.spawned()).toBe(1);
	});
});

describe("what health and budget report", () => {
	it("a ledger that answers reads reachable on health and on the tenant's budget; capabilities unchanged", async () => {
		const capabilities = await plainCapabilities();
		const { base } = await start({ spawner: fakeSpawner("reply") });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		const h = await health(base);
		expect(h.status).toBe(200);
		expect(h.body).toMatchObject({ ok: true, ledger: "reachable" });
		expect(h.body.capabilities).toEqual(capabilities);
		const b = await budget(base);
		expect(b.status).toBe(200);
		expect(b.body).toMatchObject({
			remaining: expect.any(Number),
			ledger: "reachable",
			ledgerObserver: { failures: 0, lastFailure: null },
		});
	});

	it("a probe outstanding past ledgerTimeoutMs reads unreachable, before any reply: HTTP 200, ok false, capabilities unchanged", async () => {
		const capabilities = await plainCapabilities();
		const { base } = await start({ spawner: fakeSpawner("silent") });
		await sleep(DEADLINE_MS / 3);
		expect(await ledgerOf(base)).toBe("unknown");
		const h = await until(
			() => health(base),
			(r) => r.body.ledger === "unreachable",
		);
		expect(h.status).toBe(200);
		expect(h.body).toMatchObject({ ok: false, ledger: "unreachable" });
		expect(h.body.capabilities).toEqual(capabilities);
		// The governor itself is up (the fake): budget answers, with the tenant's ledger.
		const b = await budget(base);
		expect(b.status).toBe(200);
		expect(b.body.ledger).toBe("unreachable");
	});

	it("a child's first probe counts from its spawn: one that is ready but never replies reads unreachable from spawn + ledgerTimeoutMs", async () => {
		const spawner = fakeSpawner("silent");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		try {
			health.start();
			const spawnedAt = spawner.times[0] ?? 0;
			await sleep(DEADLINE_MS / 3);
			expect(health.state(key)).toBe("unknown");
			const at = await until(
				() => (health.state(key) === "unreachable" ? performance.now() : 0),
				(v) => v > 0,
			);
			// The deadline counts from the spawn, not from the moment the probe was sent.
			expect(at - spawnedAt).toBeGreaterThanOrEqual(DEADLINE_MS - 5);
			expect(at - spawnedAt).toBeLessThan(DEADLINE_MS + 300);
			expect(health.observer(key)).toEqual({ failures: 0, lastFailure: null });
		} finally {
			health.stop();
		}
	});

	it("healthKeepAliveMs sets the keep-alive probe interval: several probes in a second with 200 ms, only the first by default; no /v1/health call needed", async () => {
		const fast = fakeSpawner("reply");
		await start({ spawner: fast, healthKeepAliveMs: 200 });
		await sleep(1_000);
		expect(fast.probes()).toBeGreaterThanOrEqual(3);
		const dflt = fakeSpawner("reply");
		await start({ spawner: dflt });
		await sleep(1_000);
		expect(dflt.probes()).toBe(1);
	});

	it("logLinesDropped above 0 with the ledger reachable: ok stays true", async () => {
		const { base } = await start({ spawner: fakeSpawner("reply") });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		// A line this process's servers could write nowhere: stderr refuses it, and the second
		// server's observer, whose spawn fails, logs one.
		vi.mocked(process.stderr.write).mockImplementation(((_chunk: unknown, ...rest: unknown[]) => {
			const done = rest.find((arg) => typeof arg === "function") as
				| ((err?: Error | null) => void)
				| undefined;
			done?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
			return false;
		}) as typeof process.stderr.write);
		const failing: HealthChildSpawner = () => {
			throw Object.assign(new Error("spawn failed"), { code: "EAGAIN" });
		};
		await start({ spawner: { ...fakeSpawner("reply"), spawnChild: failing } });
		vi.mocked(process.stderr.write).mockRestore();
		const h = await until(
			() => health(base),
			(r) => (r.body.logLinesDropped as number) > 0,
		);
		expect(h.body.logLinesDropped).toBeGreaterThan(0);
		expect(h.body).toMatchObject({ ok: true, ledger: "reachable" });
	});

	it("a ledger that stops and returns: reachable, then unreachable, then reachable", async () => {
		const dir = await mkdtemp(join(tmpdir(), "utsrv-health-switch-"));
		const control = join(dir, "ledger");
		await writeFile(control, "up");
		const { base } = await start({ spawner: fakeSpawner(`file:${control}`) });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		await writeFile(control, "down");
		// health asks at most once per ledgerTimeoutMs; the probe it sends then goes unanswered.
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "unreachable",
			),
		).toBe("unreachable");
		expect((await health(base)).body.ok).toBe(false);
		await writeFile(control, "up");
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		expect((await health(base)).body.ok).toBe(true);
	});

	it("health asks at most once per ledgerTimeoutMs", async () => {
		const spawner = fakeSpawner("reply");
		const { base } = await start({ spawner });
		await until(
			() => ledgerOf(base),
			(l) => l === "reachable",
		);
		const before = spawner.probes();
		for (let i = 0; i < 20; i++) await health(base);
		expect(spawner.probes() - before).toBeLessThanOrEqual(1);
	});

	it("a probe answered with an error reads unknown, never reachable", async () => {
		const { base } = await start({ spawner: fakeSpawner("error") });
		await sleep(DEADLINE_MS * 2);
		for (let i = 0; i < 5; i++) {
			expect((await health(base)).body).toMatchObject({ ok: true, ledger: "unknown" });
			await sleep(DEADLINE_MS / 2);
		}
	});
});

describe("an observer that cannot run reads unknown, never unreachable", () => {
	it("a child that exits at once on every spawn: 4 spawns over 3 cooldowns, unknown throughout, each failure counted", async () => {
		const cooldown = 400;
		const spawner = fakeSpawner("exit");
		const { base } = await start({ spawner, overrides: { healthRespawnCooldownMs: cooldown } });
		const readings = new Set<unknown>();
		const observer = await until(
			async () => {
				readings.add(await ledgerOf(base));
				return (await budget(base)).body.ledgerObserver as { failures: number };
			},
			(o) => o.failures >= 4,
			10_000,
		);
		expect(observer).toEqual({ failures: 4, lastFailure: "child_exited" });
		expect(spawner.spawned()).toBe(4);
		expect([...readings]).toEqual(["unknown"]);
		// Each respawn waited out its cooldown, counted from the exit: no storm.
		for (let i = 1; i < spawner.times.length; i++) {
			expect((spawner.times[i] ?? 0) - (spawner.times[i - 1] ?? 0)).toBeGreaterThanOrEqual(
				cooldown - 5,
			);
		}
		expect((spawner.times[3] ?? 0) - (spawner.times[0] ?? 0)).toBeGreaterThanOrEqual(3 * cooldown);
		// One log line per failure kind per cooldown, never per spawn.
		const lines = stderr.filter((line) => line.includes("child_exited"));
		expect(lines.length).toBeGreaterThanOrEqual(1);
		expect(lines.length).toBeLessThanOrEqual(4);
	}, 20_000);

	it("a child that aborts reads unknown, as a panic, and the server lives on", async () => {
		const { base } = await start({
			spawner: fakeSpawner("abort"),
			overrides: { healthRespawnCooldownMs: 60_000 },
		});
		const observer = await until(
			async () => (await budget(base)).body.ledgerObserver as { failures: number },
			(o) => o.failures >= 1,
		);
		expect(observer).toEqual({ failures: 1, lastFailure: "panic" });
		const h = await health(base);
		expect(h.status).toBe(200);
		expect(h.body).toMatchObject({ ok: true, ledger: "unknown" });
	});

	it("an evicted child reads unknown, counts as evicted, and is started again after the cooldown", async () => {
		const spawner = fakeSpawner("evict");
		const { base } = await start({ spawner, overrides: { healthRespawnCooldownMs: 300 } });
		const observer = await until(
			async () => (await budget(base)).body.ledgerObserver as { failures: number },
			(o) => o.failures >= 1,
		);
		expect(observer).toMatchObject({ lastFailure: "evicted" });
		expect(await ledgerOf(base)).toBe("unknown");
		expect(
			await until(
				() => spawner.spawned(),
				(n) => n >= 2,
			),
		).toBeGreaterThanOrEqual(2);
	});

	it("a spawn that throws reads unknown and never throws out of listen(); ledgerObserver carries its class only, no address, path or message", async () => {
		const spawnChild: HealthChildSpawner = () => {
			throw Object.assign(
				new Error("spawn /opt/secret/node 10.9.8.7:4321 cluster 4242 failed: EAGAIN"),
				{ code: "EAGAIN" },
			);
		};
		const { base } = await start({
			spawner: { ...fakeSpawner("reply"), spawnChild },
			file: { budget: 1_000_000, tigerbeetle: { clusterId: 4242, addresses: ["10.9.8.7:4321"] } },
			overrides: { healthRespawnCooldownMs: 60_000 },
		});
		const b = await budget(base);
		expect(b.body.ledgerObserver).toEqual({ failures: 1, lastFailure: "spawn_failed:EAGAIN" });
		expect(b.body.ledger).toBe("unknown");
		const exposed = JSON.stringify(b.body.ledgerObserver) + stderr.join("");
		for (const secret of ["10.9.8.7", "4321", "4242", "/opt/secret", "failed: EAGAIN"]) {
			expect(exposed).not.toContain(secret);
		}
		expect((await health(base)).body).toMatchObject({ ok: true, ledger: "unknown" });
		expect((await health(base)).body).not.toHaveProperty("ledgerObserver");
	});
});

describe("a child that never says ready is the observer failing, not the ledger", () => {
	const COOLDOWN = 400;

	it("it reads unknown before and after ledgerTimeoutMs, never unreachable; it is killed, counted as not_ready, and respawned after the cooldown", async () => {
		const spawner = fakeSpawner("hang");
		const lines: string[] = [];
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			respawnCooldownMs: COOLDOWN,
			spawnChild: spawner.spawnChild,
			log: (line) => lines.push(line),
		});
		const key = targetKey(TARGET);
		try {
			health.start();
			const firstPid = spawner.pids[0] as number;
			await sleep(DEADLINE_MS - 150);
			expect(health.state(key)).toBe("unknown");
			expect(alive(firstPid)).toBe(true);
			const observer = await until(
				() => health.observer(key),
				(o) => o.failures >= 1,
			);
			expect(observer).toEqual({ failures: 1, lastFailure: "not_ready" });
			// Past the deadline, and throughout the cooldown: unknown, and never a probe sent.
			const readings = new Set<string>();
			const cooldownEnd = performance.now() + COOLDOWN - 100;
			while (performance.now() < cooldownEnd) {
				readings.add(health.state(key));
				await sleep(25);
			}
			expect([...readings]).toEqual(["unknown"]);
			expect(spawner.probes()).toBe(0);
			expect(await goneWithin(firstPid, 2_000)).toBe(true);
			// After the cooldown a new child was started.
			await until(
				() => spawner.spawned(),
				(n) => n >= 2,
			);
			expect(spawner.spawned()).toBeGreaterThanOrEqual(2);
			const [first = 0, second = 0] = spawner.times;
			expect(second - first).toBeGreaterThanOrEqual(DEADLINE_MS + COOLDOWN - 5);
			expect(health.state(key)).toBe("unknown");
			expect(lines.filter((l) => l.includes("not_ready")).length).toBe(1);
		} finally {
			health.stop();
		}
	}, 20_000);

	it("a probe that was never sent is not overdue: past spawn + ledgerTimeoutMs it reads unknown, even before the ready deadline has run", async () => {
		const spawner = fakeSpawner("hang");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			respawnCooldownMs: COOLDOWN,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		try {
			health.start();
			// The clock jumps past the deadline while the ready timer has not run yet.
			const real = performance.now.bind(performance);
			const jump = vi.spyOn(performance, "now").mockImplementation(() => real() + DEADLINE_MS + 1);
			expect(health.state(key)).toBe("unknown");
			expect(health.observer(key).failures).toBe(0);
			jump.mockRestore();
		} finally {
			health.stop();
		}
	});

	it("a child that says ready in time is left alone: no kill at ledgerTimeoutMs, no failure, reachable", async () => {
		const spawner = fakeSpawner("reply");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			respawnCooldownMs: COOLDOWN,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		try {
			health.start();
			await until(
				() => health.state(key),
				(st) => st === "reachable",
			);
			// Well past the ready deadline.
			await sleep(DEADLINE_MS + 400);
			expect(health.observer(key)).toEqual({ failures: 0, lastFailure: null });
			expect(spawner.spawned()).toBe(1);
			expect(alive(spawner.pids[0] as number)).toBe(true);
			expect(health.state(key)).toBe("reachable");
		} finally {
			health.stop();
		}
	});

	it("stop() before the deadline clears it: nothing is killed late, counted or respawned", async () => {
		const spawner = fakeSpawner("hang");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			respawnCooldownMs: 100,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		health.start();
		health.stop();
		await sleep(DEADLINE_MS + 400);
		expect(health.observer(key)).toEqual({ failures: 0, lastFailure: null });
		expect(spawner.spawned()).toBe(1);
	});

	it("a child that exits before it is ready clears the deadline: only the exit is counted", async () => {
		const spawner = fakeSpawner("exit");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			respawnCooldownMs: 60_000,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		try {
			health.start();
			await until(
				() => health.observer(key).failures,
				(n) => n >= 1,
			);
			await sleep(DEADLINE_MS + 300);
			expect(health.observer(key)).toEqual({ failures: 1, lastFailure: "child_exited" });
			expect(spawner.spawned()).toBe(1);
		} finally {
			health.stop();
		}
	});
});

describe("a tenant contributes only what its own governor verified", () => {
	const A = { budget: 1_000_000, tigerbeetle: { clusterId: 0, addresses: ["127.0.0.1:3101"] } };
	const B = { budget: 1_000_000, tigerbeetle: { clusterId: 0, addresses: ["127.0.0.1:3202"] } };

	it("a tenant whose config changed after start reads unknown, with one restart line; health's aggregate includes it", async () => {
		const { base, config } = await start({ spawner: fakeSpawner("reply"), file: A });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		await writeFile(config.tenants[0]?.configPath as string, JSON.stringify(B));
		const b = await budget(base);
		expect(b.status).toBe(200);
		expect(b.body.ledger).toBe("unknown");
		expect(await ledgerOf(base)).toBe("unknown");
		const lines = stderr.filter((line) => line.includes("changed after start; restart the server"));
		expect(lines).toHaveLength(1);
		await budget(base);
		expect(stderr.filter((line) => line.includes("changed after start"))).toHaveLength(1);
	});

	/** A fake child that answers probes until `path` reads "down". */
	async function downSwitch(): Promise<string> {
		const path = join(await mkdtemp(join(tmpdir(), "utsrv-down-")), "state");
		await writeFile(path, "up");
		return path;
	}

	it("a target no tenant still uses is out of health's aggregate: it going down reads the mismatch's unknown, ok true", async () => {
		const path = await downSwitch();
		const { base, config } = await start({ spawner: fakeSpawner(`file:${path}`), file: A });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		// The tenant's config moves to B before its governor exists: it resolves on B, a mismatch.
		await writeFile(config.tenants[0]?.configPath as string, JSON.stringify(B));
		expect((await budget(base)).body.ledger).toBe("unknown");
		// A, which nobody uses now, stops answering. Health polls keep probing it past the deadline.
		await writeFile(path, "down");
		const readings = new Set<string>();
		const until2 = Date.now() + 2.5 * DEADLINE_MS + 500;
		while (Date.now() < until2) {
			const h = await health(base);
			readings.add(`${h.body.ledger}/${h.body.ok}`);
			await sleep(50);
		}
		expect([...readings]).toEqual(["unknown/true"]);
	}, 15_000);

	it("a target another tenant still uses stays in the aggregate: with one tenant mismatched, A going down reads unreachable, ok false", async () => {
		const path = await downSwitch();
		const dir = await mkdtemp(join(tmpdir(), "utsrv-two-"));
		const configs = [join(dir, "t1.json"), join(dir, "t2.json")];
		for (const c of configs) await writeFile(c, JSON.stringify(A));
		const KEY2 = "ut_health_key_2";
		const { base } = await start({
			spawner: fakeSpawner(`file:${path}`),
			overrides: {
				tenants: [
					{
						id: "acme",
						keyHash: hashKey(KEY),
						budget: 1_000_000,
						configPath: configs[0] as string,
					},
					{
						id: "beta",
						keyHash: hashKey(KEY2),
						budget: 1_000_000,
						configPath: configs[1] as string,
					},
				],
			},
		});
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		// acme moves to B (a mismatch); beta stays on A and its governor verifies.
		await writeFile(configs[0] as string, JSON.stringify(B));
		expect((await budget(base)).body.ledger).toBe("unknown");
		const betaBudget = await fetch(`${base}/v1/budget`, {
			headers: { authorization: `Bearer ${KEY2}` },
		});
		expect(((await betaBudget.json()) as { ledger: string }).ledger).toBe("reachable");
		await writeFile(path, "down");
		const h = await until(
			() => health(base),
			(r) => r.body.ledger === "unreachable",
		);
		expect(h.body).toMatchObject({ ok: false, ledger: "unreachable" });
	}, 15_000);

	it("a governor created through server.pool.get after listen(), on another ledger than the watched one, reads unknown on health and on the tenant's budget", async () => {
		const { server, base, config } = await start({ spawner: fakeSpawner("reply"), file: A });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		await writeFile(config.tenants[0]?.configPath as string, JSON.stringify(B));
		// Created directly: no authenticated route is involved.
		await server.pool.get(config.tenants[0] as ServerConfig["tenants"][number]);
		expect(await ledgerOf(base)).toBe("unknown");
		expect((await budget(base)).body.ledger).toBe("unknown");
	});

	it("a governor created through server.pool.get BEFORE listen(), whose config then changes: re-verified against the targets health watches, so unknown", async () => {
		const stateDir = await mkdtemp(join(tmpdir(), "utsrv-health-"));
		const configPath = join(stateDir, "tenant.config.json");
		await writeFile(configPath, JSON.stringify(A));
		const config: ServerConfig = {
			host: "127.0.0.1",
			port: 0,
			stateDir,
			enforcement: "enforce",
			pendingTtlMs: 300_000,
			dryRun: false,
			ledgerTimeoutMs: DEADLINE_MS,
			ledgerHealth: "child",
			tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1_000_000, configPath }],
		};
		const tenant = config.tenants[0] as ServerConfig["tenants"][number];
		const server = createUsertrustServer({
			config,
			// The governor reads the ledger the tenant's config names when it is created.
			factory: async () => {
				const used = (await resolveTenantTargets(config)).get("acme");
				const { governor } = createFakeGovernor();
				return { ...governor, config: { tigerbeetle: used } } as unknown as Governor;
			},
			spawnHealthChild: fakeSpawner("reply").spawnChild,
		});
		servers.push(server);
		await server.pool.get(tenant);
		await writeFile(configPath, JSON.stringify(B));
		const { port } = await server.listen();
		const base = `http://127.0.0.1:${port}`;
		// Health watches B (the file at start); the cached governor uses A.
		await sleep(DEADLINE_MS / 3);
		const readings = new Set<unknown>();
		for (let i = 0; i < 10; i++) {
			readings.add(await ledgerOf(base));
			await sleep(50);
		}
		expect([...readings]).toEqual(["unknown"]);
		expect((await budget(base)).body.ledger).toBe("unknown");
	});

	it("every health diagnostic goes through the server's log sink, none straight to stderr", async () => {
		const A2 = { ...A, tigerbeetle: { clusterId: 0, addresses: ["127.0.0.1:3303"] } };
		const lines: string[] = [];
		const failing: HealthChildSpawner = () => {
			throw Object.assign(new Error("spawn failed"), { code: "EAGAIN" });
		};
		const { base, config } = await start({
			spawner: { ...fakeSpawner("reply"), spawnChild: failing },
			file: A2,
			log: (line) => lines.push(line),
		});
		await writeFile(config.tenants[0]?.configPath as string, JSON.stringify(B));
		await budget(base);
		expect(
			lines.some((line) => line.includes("ledger health:") && line.includes("spawn_failed")),
		).toBe(true);
		expect(lines.some((line) => line.includes("changed after start; restart the server"))).toBe(
			true,
		);
		expect(stderr.filter((line) => line.includes("ledger"))).toEqual([]);
	});

	it("an initializing tenant reads unknown on health and a 503 unknown on budget past the deadline, never reachable; then it is verified", async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		const { base, config } = await start({ spawner: fakeSpawner("reply"), file: A, gate });
		// An unused tenant contributes nothing: the target answers.
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		// Its file now names another ledger, before its first request.
		await writeFile(config.tenants[0]?.configPath as string, JSON.stringify(B));
		const b = await budget(base);
		expect(b.status).toBe(503);
		expect(b.body).toMatchObject({ error: "ledger_unavailable", ledger: "unknown" });
		expect(b.body).not.toHaveProperty("remaining");
		for (let i = 0; i < 4; i++) {
			expect(await ledgerOf(base)).toBe("unknown");
			await sleep(DEADLINE_MS / 2);
		}
		expect((await budget(base)).body).toMatchObject({
			error: "ledger_unavailable",
			ledger: "unknown",
		});
		// The governor resolves (on B): verified against A, a mismatch.
		open();
		const verified = await until(
			() => budget(base),
			(r) => r.status === 200,
		);
		expect(verified.body.ledger).toBe("unknown");
		expect(stderr.filter((line) => line.includes("changed after start"))).toHaveLength(1);
		expect(await ledgerOf(base)).toBe("unknown");
	});

	it("budget during initialization reads unknown; once the governor is verified on the same ledger, reachable", async () => {
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => (open = resolve));
		const { base } = await start({ spawner: fakeSpawner("reply"), file: A, gate });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		const pending = budget(base);
		await sleep(50);
		expect(await ledgerOf(base)).toBe("unknown");
		expect((await pending).body).toMatchObject({ error: "ledger_unavailable", ledger: "unknown" });
		open();
		const b = await until(
			() => budget(base),
			(r) => r.status === 200,
		);
		expect(b.body.ledger).toBe("reachable");
		expect(await ledgerOf(base)).toBe("reachable");
		expect(stderr.filter((line) => line.includes("changed after start"))).toHaveLength(0);
	});
});

describe("the observer's lifecycle", () => {
	it("create, listen, close twenty times: no health child left alive", async () => {
		const spawner = fakeSpawner("reply");
		for (let i = 0; i < 20; i++) {
			const { server, base } = await start({ spawner });
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			);
			await server.close();
			// A second close is a no-op for health.
			await server.close();
		}
		expect(spawner.spawned()).toBe(20);
		for (const pid of spawner.pids) expect(await goneWithin(pid, 2_000)).toBe(true);
	}, 60_000);

	it("a stopped observer reads unknown at once: a target that was reachable, and the aggregate", async () => {
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			spawnChild: fakeSpawner("reply").spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		health.start();
		await until(
			() => health.state(key),
			(st) => st === "reachable",
		);
		expect(health.aggregate()).toBe("reachable");
		health.stop();
		expect(health.state(key)).toBe("unknown");
		expect(health.aggregate()).toBe("unknown");
	});

	it("a stopped observer never turns an abandoned probe into unreachable: stop() with a sent probe outstanding, past ledgerTimeoutMs, still reads unknown", async () => {
		const spawner = fakeSpawner("silent");
		const health = new LedgerHealth([TARGET], {
			ledgerTimeoutMs: DEADLINE_MS,
			spawnChild: spawner.spawnChild,
			log: () => {},
		});
		const key = targetKey(TARGET);
		health.start();
		// The silent child is ready and was sent its probe, which it never answers.
		await until(
			() => spawner.probes(),
			(n) => n >= 1,
		);
		health.stop();
		expect(health.state(key)).toBe("unknown");
		await sleep(DEADLINE_MS + 200);
		expect(health.state(key)).toBe("unknown");
		expect(health.aggregate()).toBe("unknown");
		expect(health.observer(key)).toEqual({ failures: 0, lastFailure: null });
	});

	it("close() begun, release still slow: /v1/health reads unknown, not the dead observer's last reachable", async () => {
		const { server, base } = await start({ spawner: fakeSpawner("reply"), releaseDelayMs: 1_500 });
		expect(
			await until(
				() => ledgerOf(base),
				(l) => l === "reachable",
			),
		).toBe("reachable");
		// A pending hold, whose release on shutdown is slow.
		const auth = await fetch(`${base}/v1/authorize`, {
			method: "POST",
			headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
			body: JSON.stringify({ model: "m", estimatedInputTokens: 1, maxOutputTokens: 1 }),
		});
		expect(auth.status).toBe(200);
		const closing = server.close();
		// close() has begun and is waiting on the release: the HTTP server still answers.
		const h = await health(base);
		expect(h.body.ledger).toBe("unknown");
		await closing;
	});

	it("after close() nothing respawns", async () => {
		const spawner = fakeSpawner("exit");
		const { server } = await start({ spawner, overrides: { healthRespawnCooldownMs: 150 } });
		await until(
			() => spawner.spawned(),
			(n) => n >= 1,
		);
		await sleep(50);
		await server.close();
		const at = spawner.spawned();
		await sleep(800);
		expect(spawner.spawned()).toBe(at);
	});

	it("after stop() nothing is probed: not by the keep-alive, not by health's poke", async () => {
		const spawner = fakeSpawner("reply");
		const health = new LedgerHealth([{ clusterId: 0, addresses: ["127.0.0.1:3001"] }], {
			ledgerTimeoutMs: DEADLINE_MS,
			keepAliveMs: 50,
			spawnChild: spawner.spawnChild,
		});
		health.start();
		const key = JSON.stringify([0, ["127.0.0.1:3001"]]);
		await until(
			() => health.state(key),
			(s) => s === "reachable",
		);
		// The keep-alive probes while it runs.
		const running = spawner.probes();
		await sleep(300);
		expect(spawner.probes()).toBeGreaterThan(running);
		health.stop();
		const at = spawner.probes();
		health.poke();
		await sleep(400);
		expect(spawner.probes()).toBe(at);
		expect(await goneWithin(spawner.pids[0] ?? 0, 2_000)).toBe(true);
	});

	it("listen() on a port in use: the same terminal stop; nothing spawns after the failure, without close()", async () => {
		const blocker: Server = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const address = blocker.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		try {
			const spawner = fakeSpawner("exit");
			const server = createUsertrustServer({
				config: {
					host: "127.0.0.1",
					port,
					stateDir: await mkdtemp(join(tmpdir(), "utsrv-health-")),
					enforcement: "enforce",
					pendingTtlMs: 300_000,
					dryRun: false,
					ledgerTimeoutMs: DEADLINE_MS,
					ledgerHealth: "child",
					healthRespawnCooldownMs: 1_000,
					tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1 }],
				},
				spawnHealthChild: spawner.spawnChild,
			});
			await expect(server.listen()).rejects.toThrow(/EADDRINUSE/);
			const at = spawner.spawned();
			// listen() started the observer before binding, so there was one to stop.
			expect(at).toBe(1);
			await sleep(3_000);
			expect(spawner.spawned()).toBe(at);
			for (const pid of spawner.pids) expect(await goneWithin(pid, 2_000)).toBe(true);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	}, 15_000);

	/** A health-child server on a free `port` (not yet listening), for the listen() lifecycle rows. */
	async function lifecycleServer(
		port: number,
		spawner: Spawner,
		ledgerHealth: "child" | "off" = "child",
	) {
		return createUsertrustServer({
			config: {
				host: "127.0.0.1",
				port,
				stateDir: await mkdtemp(join(tmpdir(), "utsrv-health-")),
				enforcement: "enforce",
				pendingTtlMs: 300_000,
				dryRun: false,
				ledgerTimeoutMs: DEADLINE_MS,
				ledgerHealth,
				healthRespawnCooldownMs: 300,
				tenants: [{ id: "acme", keyHash: hashKey(KEY), budget: 1 }],
			},
			spawnHealthChild: spawner.spawnChild,
		});
	}

	/** True when nothing accepts a connection on `port`. */
	async function refuses(port: number): Promise<boolean> {
		return new Promise((resolve) => {
			const socket = connect({ port, host: "127.0.0.1" });
			socket.once("connect", () => {
				socket.destroy();
				resolve(false);
			});
			socket.once("error", () => resolve(true));
		});
	}

	it("close() during listen(), ledgerHealth off: listen() rejects and nothing listens", async () => {
		const port = await freePort();
		const server = await lifecycleServer(port, fakeSpawner("reply"), "off");
		const starting = server.listen();
		const rejected = expect(starting).rejects.toThrow(/close\(\) ran before listen\(\) finished/);
		await server.close();
		await rejected;
		expect(await refuses(port)).toBe(true);
	});

	it("close() during listen(), ledgerHealth child: listen() rejects, nothing listens, no health child is left alive", async () => {
		const port = await freePort();
		const spawner = fakeSpawner("reply");
		const server = await lifecycleServer(port, spawner);
		const starting = server.listen();
		const rejected = expect(starting).rejects.toThrow(/close\(\) ran before listen\(\) finished/);
		await server.close();
		await rejected;
		await sleep(DEADLINE_MS);
		expect(await refuses(port)).toBe(true);
		// Whether or not health had started when close() ran, none is alive or respawned.
		const at = spawner.spawned();
		await sleep(700);
		expect(spawner.spawned()).toBe(at);
		for (const pid of spawner.pids) expect(await goneWithin(pid, 2_000)).toBe(true);
	}, 15_000);

	it("a synchronous throw from the HTTP listen (ERR_SOCKET_BAD_PORT): listen() rejects, and health is stopped, with no respawn", async () => {
		const spawner = fakeSpawner("exit");
		const server = await lifecycleServer(70_000, spawner);
		await expect(server.listen()).rejects.toMatchObject({ code: "ERR_SOCKET_BAD_PORT" });
		const at = spawner.spawned();
		expect(at).toBe(1);
		await sleep(1_500);
		expect(spawner.spawned()).toBe(at);
		for (const pid of spawner.pids) expect(await goneWithin(pid, 2_000)).toBe(true);
	}, 15_000);
});

describe("the real health child never holds its parent, and never outlives it", () => {
	const savedNodeOptions = process.env.NODE_OPTIONS;
	const parentEnv = () => ({
		...process.env,
		NODE_OPTIONS: `${savedNodeOptions ?? ""} --import "${PRELOAD}"`.trim(),
	});

	/** Start health-parent.ts; resolves with it and its child's pid. */
	async function parent(mode: "hold" | "return" | "respawn" | "notready") {
		const proc = spawn(process.execPath, [HEALTH_PARENT, String(await freePort()), mode], {
			env: parentEnv(),
			stdio: ["ignore", "pipe", "inherit"],
		});
		if (proc.pid !== undefined) started.push(proc.pid);
		const exited = new Promise<number>((resolve) =>
			proc.once("exit", () => resolve(performance.now())),
		);
		const childPid = await new Promise<number>((resolve, reject) => {
			let out = "";
			proc.stdout.setEncoding("utf-8");
			proc.stdout.on("data", (chunk: string) => {
				out += chunk;
				const line = out.split("\n")[0];
				if (out.includes("\n") && line !== undefined) resolve(Number(line));
			});
			proc.once("exit", () => reject(new Error("the parent exited before its child started")));
		});
		started.push(childPid);
		return { proc, childPid, printedAt: performance.now(), exited };
	}

	it("a parent that returns from main with the observer running exits by itself within 1 s; its orphaned child then exits within 2 s", async () => {
		const { childPid, printedAt, exited } = await parent("return");
		const exitedAt = await Promise.race([exited, sleep(5_000).then(() => Number.NaN)]);
		expect(exitedAt - printedAt, "the parent was held open").toBeLessThan(1_000);
		expect(await goneWithin(childPid, 2_000)).toBe(true);
	}, 30_000);

	it("a parent whose child has exited, with a respawn pending for 300 s, exits by itself within 1 s", async () => {
		const { childPid, printedAt, exited } = await parent("respawn");
		const exitedAt = await Promise.race([exited, sleep(5_000).then(() => Number.NaN)]);
		expect(exitedAt - printedAt, "a pending respawn held the parent open").toBeLessThan(1_000);
		expect(alive(childPid)).toBe(false);
	}, 30_000);

	it("a parent whose child never says ready, with its ready deadline pending for 5 s, exits by itself within 1 s", async () => {
		const { childPid, printedAt, exited } = await parent("notready");
		const exitedAt = await Promise.race([exited, sleep(4_000).then(() => Number.NaN)]);
		expect(exitedAt - printedAt, "the ready deadline held the parent open").toBeLessThan(1_000);
		expect(await goneWithin(childPid, 2_000)).toBe(true);
	}, 30_000);

	it("a health child exits within 2 s of its parent being SIGKILLed", async () => {
		const { proc, childPid } = await parent("hold");
		// Let the child get well into its life: booted, client created, probed.
		await sleep(1_000);
		expect(alive(childPid)).toBe(true);
		proc.kill("SIGKILL");
		expect(await goneWithin(childPid, 2_000)).toBe(true);
	}, 30_000);
});

describe("the children share one native loader", () => {
	it("the health child takes as an eviction every code the core ledger client does, and a client closed under it", () => {
		const core = readFileSync(join(SRC, "..", "..", "core", "src", "ledger", "client.ts"), "utf-8");
		const healthChild = readFileSync(join(SRC, "cli", "ledger-health-child.ts"), "utf-8");
		const codes = (source: string) => {
			const block = /const EVICTION_CODES: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(
				source,
			);
			return [...(block?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort();
		};
		expect(codes(core).length).toBeGreaterThan(0);
		expect(codes(healthChild)).toEqual([...codes(core), "ERR_CLIENT_CLOSED"].sort());
	});

	it("both import tigerbeetle-load, and the health child's orphan safety is the probe child's, verbatim", () => {
		const probe = readFileSync(join(SRC, "cli", "ledger-probe-child.ts"), "utf-8");
		const healthChild = readFileSync(join(SRC, "cli", "ledger-health-child.ts"), "utf-8");
		for (const source of [probe, healthChild]) {
			expect(source).toContain('import { loadTigerBeetle } from "./tigerbeetle-load.js";');
			expect(source).not.toContain("createRequire");
			expect(source).not.toContain('"tigerbeetle-node"');
		}
		const orphanSafety = probe.slice(
			probe.indexOf("// The parent's IPC channel closes"),
			probe.indexOf("}, 250).unref();") + "}, 250).unref();".length,
		);
		expect(orphanSafety.length).toBeGreaterThan(200);
		expect(healthChild).toContain(orphanSafety);
		expect(healthChild).not.toMatch(/\.destroy\(/);
	});
});
