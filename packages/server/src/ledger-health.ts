// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Ledger reachability for `/v1/health` and `/v1/budget`: one long-lived child process per distinct
 * ledger target (cli/ledger-health-child.ts), each holding ONE TigerBeetle session, probed with
 * `lookupAccounts([])` over IPC. The server process loads no native TigerBeetle code for this: a
 * blocked io_uring or a native panic kills only the child, which then reads `unknown`.
 *
 * A target is:
 * - `unreachable` while a probe that WAS SENT to the child is outstanding past `ledgerTimeoutMs`
 *   (this has precedence, and applies before the first reply too);
 * - `reachable` when its last probe got a reply and none is overdue;
 * - `unknown` otherwise: no reply yet, the child dead or evicted and waiting to respawn, a spawn
 *   that failed, a probe answered with an error, or a child that is not ready.
 *
 * A child's first probe is outstanding from the moment it is spawned, and is sent to it once it
 * says it is ready (a message sent before the child listens could be lost), so its deadline counts
 * from the spawn. A child that is not ready within `ledgerTimeoutMs` (say its TigerBeetle load
 * hangs) never had the ledger asked, so that is the observer failing, not the ledger: it reads
 * `unknown` (`not_ready`), is killed, and is respawned after the cooldown. Then a probe every 30 s
 * while none is outstanding, and at most once per
 * `ledgerTimeoutMs` more when `/v1/health` asks (`poke`). A child that exits, or a
 * spawn that fails, is respawned after `respawnCooldownMs`, counted from the exit. Nothing here
 * holds this process open: the child, its IPC channel and every timer (the keep-alive, a pending
 * respawn and a child's ready deadline) are unref'd, and the child
 * has no stdio pipe (a live pipe keeps a finished parent alive even after `unref()`).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LedgerTarget } from "./ledger-probe.js";

export type LedgerState = "reachable" | "unreachable" | "unknown";

/** How long a dead child's target waits before its child is started again, unless configured. */
export const DEFAULT_HEALTH_RESPAWN_COOLDOWN_MS = 300_000;
/** A probe this often while none is outstanding: it keeps the session from going idle. */
export const HEALTH_KEEPALIVE_MS = 30_000;

/** How a target's child process is started. Injectable so a test can count or replace them. */
export type HealthChildSpawner = (target: LedgerTarget) => ChildProcess;

/** One target's key: its cluster id and addresses, as `resolveLedgerTargets` deduplicates them. */
export function targetKey(target: LedgerTarget): string {
	return JSON.stringify([target.clusterId, target.addresses]);
}

/** The child script, in cli/ beside this module: `.ts` when running from source, else `.js`. */
function childScript(): string {
	const self = fileURLToPath(import.meta.url);
	return join(self, "..", "cli", `ledger-health-child${self.endsWith(".ts") ? ".ts" : ".js"}`);
}

/** Start the health child for `target`: no stdio at all, only the IPC channel. */
export function spawnHealthChild(target: LedgerTarget): ChildProcess {
	return spawn(
		process.execPath,
		[childScript(), String(target.clusterId), JSON.stringify(target.addresses)],
		{ stdio: ["ignore", "ignore", "ignore", "ipc"] },
	);
}

/** The worst of several states: unreachable, then unknown, then reachable. */
export function worstState(states: Iterable<LedgerState>): LedgerState {
	let worst: LedgerState = "reachable";
	for (const state of states) {
		if (state === "unreachable") return "unreachable";
		if (state === "unknown") worst = "unknown";
	}
	return worst;
}

interface Target {
	target: LedgerTarget;
	/** Its 1-based position, for log lines: never its addresses. */
	index: number;
	child?: ChildProcess | undefined;
	/** The child has its client and can be probed. */
	ready: boolean;
	/** The outstanding probe has been sent to the child (the first waits for it to be ready). */
	sent: boolean;
	seq: number;
	outstanding?: { n: number; sentAt: number } | undefined;
	lastProbeAt?: number | undefined;
	lastOutcome: "none" | "reply" | "error";
	evicted: boolean;
	respawn?: NodeJS.Timeout | undefined;
	/** The deadline for the current child to say it is ready: it fires `not_ready`. */
	readyTimer?: NodeJS.Timeout | undefined;
	failures: number;
	lastFailure: string | null;
	/** Per log kind, when it was last logged (monotonic): one line per kind per cooldown. */
	logged: Map<string, number>;
}

export interface LedgerHealthOptions {
	ledgerTimeoutMs: number;
	respawnCooldownMs?: number;
	keepAliveMs?: number;
	spawnChild?: HealthChildSpawner;
	log?: (line: string) => void;
}

export class LedgerHealth {
	private closing = false;
	private readonly byKey = new Map<string, Target>();
	private keepAlive: NodeJS.Timeout | undefined;
	private readonly cooldownMs: number;
	private readonly spawnChild: HealthChildSpawner;
	private readonly log: (line: string) => void;

	constructor(
		targets: LedgerTarget[],
		private readonly opts: LedgerHealthOptions,
	) {
		this.cooldownMs = opts.respawnCooldownMs ?? DEFAULT_HEALTH_RESPAWN_COOLDOWN_MS;
		this.spawnChild = opts.spawnChild ?? spawnHealthChild;
		this.log =
			opts.log ?? ((line) => process.stderr.write(`usertrust-server: ledger health: ${line}\n`));
		for (const target of targets) {
			const key = targetKey(target);
			if (this.byKey.has(key)) continue;
			this.byKey.set(key, {
				target,
				index: this.byKey.size + 1,
				ready: false,
				sent: false,
				seq: 0,
				lastOutcome: "none",
				evicted: false,
				failures: 0,
				lastFailure: null,
				logged: new Map(),
			});
		}
	}

	/** Start one child per target, and the keep-alive. */
	start(): void {
		if (this.closing) return;
		for (const t of this.byKey.values()) this.spawn(t);
		const keepAlive = setInterval(() => {
			for (const t of this.byKey.values()) this.probe(t);
		}, this.opts.keepAliveMs ?? HEALTH_KEEPALIVE_MS);
		keepAlive.unref();
		this.keepAlive = keepAlive;
	}

	/**
	 * The ONE terminal stop, synchronous: from here on nothing is probed or spawned, every timer is
	 * cleared and every child is SIGKILLed. A late reply, exit or spawn result is ignored. A second
	 * call does nothing.
	 */
	stop(): void {
		if (this.closing) return;
		this.closing = true;
		if (this.keepAlive !== undefined) clearInterval(this.keepAlive);
		for (const t of this.byKey.values()) {
			if (t.respawn !== undefined) clearTimeout(t.respawn);
			t.respawn = undefined;
			this.clearReadyTimer(t);
			const child = t.child;
			t.child = undefined;
			child?.kill("SIGKILL");
		}
	}

	/** `/v1/health` asks: probe each ready target at most once per `ledgerTimeoutMs`. */
	poke(): void {
		if (this.closing) return;
		const now = performance.now();
		for (const t of this.byKey.values()) {
			if (t.lastProbeAt !== undefined && now - t.lastProbeAt < this.opts.ledgerTimeoutMs) continue;
			this.probe(t);
		}
	}

	/**
	 * A target's state, by its key; `unknown` for a key this observer does not watch. `unreachable`
	 * needs a probe the child was actually sent: one still waiting for a child that is not ready
	 * says nothing about the ledger (the ready deadline turns that into `unknown`, `not_ready`).
	 */
	state(key: string): LedgerState {
		const t = this.byKey.get(key);
		if (t === undefined) return "unknown";
		if (
			t.outstanding !== undefined &&
			t.sent &&
			performance.now() - t.outstanding.sentAt > this.opts.ledgerTimeoutMs
		) {
			return "unreachable";
		}
		return t.lastOutcome === "reply" ? "reachable" : "unknown";
	}

	/** The worst state over every target. */
	aggregate(): LedgerState {
		return worstState([...this.byKey.keys()].map((key) => this.state(key)));
	}

	/** How often this target's observer failed, and the class of the last failure: no detail. */
	observer(key: string): { failures: number; lastFailure: string | null } {
		const t = this.byKey.get(key);
		return { failures: t?.failures ?? 0, lastFailure: t?.lastFailure ?? null };
	}

	private spawn(t: Target): void {
		if (this.closing) return;
		t.ready = false;
		t.evicted = false;
		t.outstanding = undefined;
		t.lastOutcome = "none";
		let child: ChildProcess;
		try {
			child = this.spawnChild(t.target);
		} catch (err) {
			this.failed(t, `spawn_failed:${errorCode(err)}`);
			return;
		}
		t.child = child;
		// The first probe is outstanding from the spawn: its deadline counts from now.
		const now = performance.now();
		t.outstanding = { n: ++t.seq, sentAt: now };
		t.lastProbeAt = now;
		t.sent = false;
		// Nothing of the child holds this process open.
		child.unref();
		child.channel?.unref();
		this.clearReadyTimer(t);
		// A child that is not ready in time is the observer failing, not the ledger.
		const readyTimer = setTimeout(() => {
			if (this.closing || t.child !== child || t.ready) return;
			t.readyTimer = undefined;
			// Detach first, so the exit this kill causes is ignored.
			t.child = undefined;
			child.kill("SIGKILL");
			this.failed(t, "not_ready");
		}, this.opts.ledgerTimeoutMs);
		readyTimer.unref();
		t.readyTimer = readyTimer;
		child.on("message", (message: unknown) => this.onMessage(t, child, message));
		child.once("error", (err) => {
			if (this.closing || t.child !== child) return;
			t.child = undefined;
			this.clearReadyTimer(t);
			child.kill("SIGKILL");
			this.failed(t, child.pid === undefined ? `spawn_failed:${errorCode(err)}` : "child_error");
		});
		child.once("exit", (code, signal) => {
			if (this.closing || t.child !== child) return;
			t.child = undefined;
			this.clearReadyTimer(t);
			const kind = t.evicted || code === 5 ? "evicted" : signal !== null ? "panic" : "child_exited";
			this.failed(t, kind);
		});
	}

	private onMessage(t: Target, child: ChildProcess, message: unknown): void {
		if (this.closing || t.child !== child || message === null || typeof message !== "object") {
			return;
		}
		const m = message as Record<string, unknown>;
		if (m.ready === true) {
			t.ready = true;
			this.clearReadyTimer(t);
			if (t.outstanding !== undefined && !t.sent) this.send(t, t.outstanding.n);
			else this.probe(t);
		} else if (typeof m.reply === "number") {
			if (t.outstanding?.n !== m.reply) return;
			t.outstanding = undefined;
			t.lastOutcome = "reply";
		} else if (typeof m.error === "number") {
			if (t.outstanding?.n !== m.error) return;
			t.outstanding = undefined;
			t.lastOutcome = "error";
			this.logOnce(t, "probe_error", "a probe was answered with an error; it reads unknown");
		} else if (m.evicted === true) {
			t.evicted = true;
		} else if (typeof m.log === "string") {
			this.logOnce(t, "child_log", m.log.slice(0, 200));
		}
	}

	private clearReadyTimer(t: Target): void {
		if (t.readyTimer !== undefined) clearTimeout(t.readyTimer);
		t.readyTimer = undefined;
	}

	/** Send a probe, single-flight: never while one is outstanding, and only to a ready child. */
	private probe(t: Target): void {
		if (this.closing || t.child === undefined || !t.ready || t.outstanding !== undefined) return;
		const n = ++t.seq;
		const now = performance.now();
		t.outstanding = { n, sentAt: now };
		t.lastProbeAt = now;
		this.send(t, n);
	}

	private send(t: Target, n: number): void {
		t.sent = true;
		try {
			t.child?.send({ probe: n });
		} catch {
			// The channel is closing: the child's exit follows.
		}
	}

	/** The observer could not run: `unknown`, counted, logged once per kind per cooldown, respawned after it. */
	private failed(t: Target, kind: string): void {
		if (this.closing) return;
		t.ready = false;
		t.outstanding = undefined;
		t.lastOutcome = "none";
		t.failures += 1;
		t.lastFailure = kind;
		this.logOnce(
			t,
			kind,
			`the observer for ledger ${t.index} failed (${kind}); it reads unknown, and restarts in ${this.cooldownMs} ms`,
		);
		const respawn = setTimeout(() => {
			t.respawn = undefined;
			this.spawn(t);
		}, this.cooldownMs);
		respawn.unref();
		t.respawn = respawn;
	}

	private logOnce(t: Target, kind: string, line: string): void {
		const now = performance.now();
		const last = t.logged.get(kind);
		if (last !== undefined && now - last < this.cooldownMs) return;
		t.logged.set(kind, now);
		this.log(line);
	}
}

/** A spawn error's code (`ENOENT`, `EAGAIN`, `EPERM`), never its message. */
function errorCode(err: unknown): string {
	const code = (err as { code?: unknown } | null)?.code;
	return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
}
