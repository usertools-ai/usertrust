// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * The `withTaskLimit()` scope: which calls belong to a task.
 *
 * Like `withCostCenter`, the task comes from code structure, never from request content: a call
 * belongs to a task because it ran inside `withTaskLimit(taskId, limit, fn)`, propagated by
 * `AsyncLocalStorage`. What is pinned here:
 *  - the arguments are checked in a fixed order, before `fn` runs, with no I/O: the arity first
 *    (a fourth argument is refused, so options added later can never change what code written
 *    today means), then the task id, the limit, `fn`, and a task already active (nesting is
 *    refused: honouring only the inner task would let it escape the outer limit);
 *  - inside `fn` the scope exposes the id, the limit and a fresh attempt id per entry, and outside
 *    it nothing; the scope follows awaits, timers and promises started inside `fn`, and does NOT
 *    follow an emitter listener into its emit-time context (the reason a controller reads the
 *    scope once, at its entry point);
 *  - the scope record is frozen and holds only its own fields;
 *  - the task key is the ledger's derivation, in 32 lowercase hex characters;
 *  - a task scope and a cost-center scope compose either way round.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

// The ledger client is imported only to compare the task key with its derivation. Its module
// scope touches only these shapes at import time (as in budget/context.test.ts).
vi.mock("tigerbeetle-node", () => ({
	createClient: vi.fn(),
	AccountFlags: { debits_must_not_exceed_credits: 2, history: 8 },
	TransferFlags: { linked: 1, pending: 2, post_pending_transfer: 4, void_pending_transfer: 8 },
	CreateAccountStatus: { created: 4294967295, exists: 21 },
	CreateTransferStatus: { created: 4294967295, exists: 46 },
	amount_max: (1n << 128n) - 1n,
}));

import { getCurrentCostCenter, withCostCenter } from "../../src/budget/attribution.js";
import { getCurrentTask, taskKeyHex, withTaskLimit } from "../../src/budget/task.js";
import { TrustTBClient } from "../../src/ledger/client.js";
import { PRINCIPAL_FIELD_PATTERN } from "../../src/shared/principal.js";

const TASK_ID_MESSAGE = `withTaskLimit: taskId must match ${PRINCIPAL_FIELD_PATTERN.source}`;
const LIMIT_MESSAGE = "withTaskLimit: limit must be a positive safe integer (usertokens)";
const ARITY_MESSAGE = "withTaskLimit: takes (taskId, limit, fn); options are not accepted yet";
const FN_MESSAGE = "withTaskLimit: fn must be a function";

/** Calls withTaskLimit with arguments its types refuse, to reach the runtime checks. */
const untyped = withTaskLimit as unknown as (...args: unknown[]) => unknown;

describe("withTaskLimit: the arguments are checked before fn runs", () => {
	it.each([
		["a slash, kept free for a later child grammar", "a/b"],
		["an empty id", ""],
		["129 characters", "a".repeat(129)],
		["a non-ASCII character", "\u00e9"],
		["a space", "a b"],
	])("refuses a bad taskId before fn runs: %s", (_name, taskId) => {
		const fn = vi.fn();
		expect(() => withTaskLimit(taskId, 10, fn)).toThrow(TASK_ID_MESSAGE);
		expect(fn).not.toHaveBeenCalled();
	});

	it("refuses a taskId that is not a string, with the same message", () => {
		const fn = vi.fn();
		expect(() => untyped(42, 10, fn)).toThrow(TASK_ID_MESSAGE);
		expect(fn).not.toHaveBeenCalled();
	});

	it("accepts the whole v1 charset, at 1 and at 128 characters", () => {
		expect(withTaskLimit("A", 1, () => getCurrentTask()?.id)).toBe("A");
		const longest = `aZ0._:-${"x".repeat(121)}`;
		expect(longest).toHaveLength(128);
		expect(withTaskLimit(longest, 1, () => getCurrentTask()?.id)).toBe(longest);
	});

	it.each([
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["above the safe integers", 2 ** 53],
		["a numeric string", "10"],
		["a bigint", 10n],
	])("refuses a non-positive, fractional or unsafe limit: %s", (_name, limit) => {
		const fn = vi.fn();
		expect(() => untyped("t", limit, fn)).toThrow(LIMIT_MESSAGE);
		expect(fn).not.toHaveBeenCalled();
	});

	it("accepts a limit of 1 and of Number.MAX_SAFE_INTEGER", () => {
		expect(withTaskLimit("t", 1, () => getCurrentTask()?.limit)).toBe(1);
		expect(withTaskLimit("t", Number.MAX_SAFE_INTEGER, () => getCurrentTask()?.limit)).toBe(
			Number.MAX_SAFE_INTEGER,
		);
	});

	it.each([
		["an options object", {}],
		["undefined", undefined],
	])("refuses a fourth argument, %s included, before fn runs", (_name, fourth) => {
		const fn = vi.fn();
		const err = (() => {
			try {
				untyped("t", 10, fn, fourth);
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(err).toBeInstanceOf(TypeError);
		expect((err as Error).message).toBe(ARITY_MESSAGE);
		expect(fn).not.toHaveBeenCalled();
	});

	it("a fourth argument is a type error too", () => {
		// @ts-expect-error: options are not accepted yet
		expect(() => withTaskLimit("t", 10, () => 1, {})).toThrow(ARITY_MESSAGE);
	});

	it("refuses an fn that is not a function", () => {
		const err = (() => {
			try {
				untyped("t", 10, "not a function");
			} catch (e) {
				return e;
			}
			return undefined;
		})();
		expect(err).toBeInstanceOf(TypeError);
		expect((err as Error).message).toBe(FN_MESSAGE);
	});

	it("checks in a fixed order: arity, taskId, limit, fn, then an active task", () => {
		expect(() => untyped("a/b", 0, "x", {})).toThrow(ARITY_MESSAGE);
		expect(() => untyped("a/b", 0, "x")).toThrow(TASK_ID_MESSAGE);
		expect(() => untyped("t", 0, "x")).toThrow(LIMIT_MESSAGE);
		expect(() => untyped("t", 1, "x")).toThrow(FN_MESSAGE);
		withTaskLimit("outer", 10, () => {
			// Inside a task, a bad argument is still reported as itself, not as nesting.
			expect(() => untyped("a/b", 1, () => 1)).toThrow(TASK_ID_MESSAGE);
		});
	});
});

describe("withTaskLimit: nesting is refused", () => {
	it("refuses a nested withTaskLimit, naming the outer task, and leaves the outer scope active", () => {
		const inner = vi.fn();
		withTaskLimit("outer", 10, () => {
			expect(() => withTaskLimit("inner", 5, inner)).toThrow(
				"withTaskLimit: a task limit is already active (outer); nested task limits are not supported",
			);
			expect(getCurrentTask()?.id).toBe("outer");
		});
		expect(inner).not.toHaveBeenCalled();
	});

	it("refuses the same task id nested, and a nested entry reached through an await", async () => {
		await withTaskLimit("same", 10, async () => {
			expect(() => withTaskLimit("same", 10, () => 1)).toThrow(/already active \(same\)/);
			await Promise.resolve();
			expect(() => withTaskLimit("later", 10, () => 1)).toThrow(/already active \(same\)/);
		});
	});

	it("allows one task after another", () => {
		expect(withTaskLimit("first", 10, () => getCurrentTask()?.id)).toBe("first");
		expect(withTaskLimit("second", 10, () => getCurrentTask()?.id)).toBe("second");
	});
});

describe("withTaskLimit: the scope inside fn", () => {
	it("exposes id, limit and a fresh 32-hex attempt per entry inside fn, nothing outside", () => {
		expect(getCurrentTask()).toBeUndefined();
		const first = withTaskLimit("triage-1", 2_000, () => getCurrentTask());
		const second = withTaskLimit("triage-1", 2_000, () => getCurrentTask());
		expect(getCurrentTask()).toBeUndefined();
		expect(first).toMatchObject({ id: "triage-1", limit: 2_000 });
		expect(first?.attempt).toMatch(/^[0-9a-f]{32}$/);
		expect(second?.attempt).toMatch(/^[0-9a-f]{32}$/);
		expect(second?.attempt).not.toBe(first?.attempt);
		// The entry time on the monotonic clock, for the attempt's wall time later.
		expect(Number.isFinite(first?.startedAtMs)).toBe(true);
		expect(first?.startedAtMs).toBeGreaterThanOrEqual(0);
		expect(second?.startedAtMs).toBeGreaterThanOrEqual(first?.startedAtMs ?? 0);
	});

	it("is the same record on every read within one entry", () => {
		withTaskLimit("t", 10, () => {
			expect(getCurrentTask()).toBe(getCurrentTask());
		});
	});

	it("returns what fn returns, and its promise's value when fn is async", async () => {
		expect(withTaskLimit("t", 10, () => 42)).toBe(42);
		await expect(withTaskLimit("t", 10, async () => "done")).resolves.toBe("done");
	});

	it("rethrows what fn throws, and leaves no scope behind", async () => {
		expect(() =>
			withTaskLimit("t", 10, () => {
				throw new Error("boom-sync");
			}),
		).toThrow("boom-sync");
		expect(getCurrentTask()).toBeUndefined();
		await expect(
			withTaskLimit("t", 10, async () => {
				throw new Error("boom-async");
			}),
		).rejects.toThrow("boom-async");
		expect(getCurrentTask()).toBeUndefined();
	});

	it("a scope survives awaits and timers started inside fn", async () => {
		const seen: Array<string | undefined> = [];
		const settled: Array<Promise<void>> = [];
		await withTaskLimit("timers", 10, async () => {
			await Promise.resolve();
			seen.push(getCurrentTask()?.id);
			settled.push(
				new Promise<void>((resolve) => {
					queueMicrotask(() => {
						seen.push(getCurrentTask()?.id);
						resolve();
					});
				}),
				new Promise<void>((resolve) => {
					setTimeout(() => {
						seen.push(getCurrentTask()?.id);
						resolve();
					}, 0);
				}),
				new Promise<void>((resolve) => {
					setImmediate(() => {
						seen.push(getCurrentTask()?.id);
						resolve();
					});
				}),
			);
		});
		await Promise.all(settled);
		expect(seen).toEqual(["timers", "timers", "timers", "timers"]);
	});

	it("a promise started inside fn and settled after fn returned still sees the task", async () => {
		let later: Promise<string | undefined> = Promise.resolve(undefined);
		withTaskLimit("detached", 10, () => {
			later = new Promise((resolve) => {
				setTimeout(() => resolve(getCurrentTask()?.id), 0);
			});
		});
		expect(getCurrentTask()).toBeUndefined();
		await expect(later).resolves.toBe("detached");
	});

	it("two concurrent tasks never see each other's scope", async () => {
		const run = (id: string) =>
			withTaskLimit(id, 10, async () => {
				const ids: Array<string | undefined> = [];
				for (let i = 0; i < 3; i++) {
					ids.push(getCurrentTask()?.id);
					await new Promise((r) => setImmediate(r));
				}
				return ids;
			});
		const [a, b] = await Promise.all([run("task-a"), run("task-b")]);
		expect(a).toEqual(["task-a", "task-a", "task-a"]);
		expect(b).toEqual(["task-b", "task-b", "task-b"]);
	});

	it("an emitter listener registered inside fn and emitted outside sees no task", () => {
		// emit() runs its listeners synchronously in the emitting context, not the one on() ran
		// in, so a read inside a listener sees whatever is active when the event fires. That is
		// why a controller reads the task once, at its own entry point, and carries it from there.
		const emitter = new EventEmitter();
		let seen: string | undefined = "sentinel-never-overwritten";
		withTaskLimit("emitter-task", 10, () => {
			emitter.on("tick", () => {
				seen = getCurrentTask()?.id;
			});
		});
		expect(getCurrentTask()).toBeUndefined();
		emitter.emit("tick");
		expect(seen).toBeUndefined();
	});
});

describe("withTaskLimit: the scope record", () => {
	it("the scope record is frozen and carries no caller key", () => {
		const fn = () => getCurrentTask();
		const scope = withTaskLimit("frozen", 10, fn);
		expect(scope).toBeDefined();
		if (!scope) return;
		expect(Object.isFrozen(scope)).toBe(true);
		expect(Object.keys(scope).sort()).toEqual(["attempt", "id", "limit", "registry", "startedAtMs"]);
		expect(Object.values(scope)).not.toContain(fn);
		expect(() => {
			// @ts-expect-error: exercising the runtime freeze against a caller ignoring `readonly`
			scope.limit = 1_000_000;
		}).toThrow(TypeError);
		expect(() => {
			// @ts-expect-error: exercising the runtime freeze against a caller ignoring `readonly`
			scope.id = "hijacked";
		}).toThrow(TypeError);
		expect(scope).toMatchObject({ id: "frozen", limit: 10 });
	});

	it("a mutation attempt inside fn does not reach a later read", () => {
		withTaskLimit("t", 10, () => {
			const scope = getCurrentTask() as unknown as Record<string, unknown>;
			expect(() => {
				scope.limit = 99;
			}).toThrow(TypeError);
			expect(getCurrentTask()?.limit).toBe(10);
		});
	});

	it("each entry has its own registry", () => {
		const a = withTaskLimit("t", 10, () => getCurrentTask()?.registry);
		const b = withTaskLimit("t", 10, () => getCurrentTask()?.registry);
		expect(a).toBeDefined();
		expect(a).not.toBe(b);
	});
});

describe("taskKeyHex", () => {
	it("taskKeyHex matches TrustTBClient.deriveTaskLimitAccountId", () => {
		for (const [ns, id] of [
			["local", "a"],
			["acme:eu", "build.1"],
			["local", "t41"],
		] as const) {
			const key = TrustTBClient.deriveTaskLimitAccountId(ns, id);
			expect(taskKeyHex(ns, id)).toBe(key.toString(16).padStart(32, "0"));
		}
	});

	it("is 32 lowercase hex characters, zero-padded", () => {
		// Known answers computed outside the implementation. ("local", "t41") derives a key below
		// 2^124, so its hex needs a leading zero to stay 32 characters.
		expect(taskKeyHex("local", "a")).toBe("fd3e171398e94159026d25d7998a9ff5");
		expect(taskKeyHex("local", "t41")).toBe("0abea49efb7039a2b5b61c857c41688b");
		expect(taskKeyHex("acme:eu", "build.1")).toMatch(/^[0-9a-f]{32}$/);
	});
});

describe("withTaskLimit and withCostCenter compose", () => {
	it("withCostCenter inside withTaskLimit and the reverse both expose both scopes", async () => {
		const inside = withTaskLimit("run-42", 500, () =>
			withCostCenter("research", () => [getCurrentTask()?.id, getCurrentCostCenter()?.costCenter]),
		);
		expect(inside).toEqual(["run-42", "research"]);
		const reverse = await withCostCenter("research", () =>
			withTaskLimit("run-43", 500, async () => {
				await Promise.resolve();
				return [getCurrentTask()?.id, getCurrentCostCenter()?.costCenter];
			}),
		);
		expect(reverse).toEqual(["run-43", "research"]);
		expect(getCurrentTask()).toBeUndefined();
		expect(getCurrentCostCenter()).toBeUndefined();
	});
});
