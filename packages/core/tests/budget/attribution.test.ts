// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { getCurrentCostCenter, withCostCenter } from "../../src/budget/attribution.js";

// The two existing costCenter charset-door messages this scope's own message must
// stay textually distinct from — ledger/client.ts:340 and budget/allocation.ts:114.
// Copied as literals (not imported) so this suite still catches a regression if
// either door's wording ever collapses onto the scope-entry message by accident.
const LEDGER_DOOR_MESSAGE = "Invalid costCenter: must match /^[a-zA-Z0-9._-]{1,64}$/";
const ALLOCATION_DOOR_MESSAGE = "budget: costCenter must match /^[a-zA-Z0-9._-]{1,64}$/";

describe("withCostCenter — validation is fail-fast and pre-I/O", () => {
	it("rejects a costCenter outside COST_CENTER_PATTERN before running fn", () => {
		let ran = false;
		expect(() =>
			withCostCenter("has a space", () => {
				ran = true;
			}),
		).toThrow(/costCenter/);
		expect(ran).toBe(false);
	});

	it("rejects an empty costCenter", () => {
		let ran = false;
		expect(() =>
			withCostCenter("", () => {
				ran = true;
			}),
		).toThrow(/costCenter/);
		expect(ran).toBe(false);
	});

	it("rejects a non-string costCenter", () => {
		let ran = false;
		expect(() =>
			// @ts-expect-error — exercising the runtime guard against a caller ignoring the type
			withCostCenter(42, () => {
				ran = true;
			}),
		).toThrow(/costCenter/);
		expect(ran).toBe(false);
	});

	it("throws a message distinct from both existing costCenter charset-door messages", () => {
		let message = "";
		try {
			withCostCenter("bad cc", () => "unreached");
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).not.toBe(LEDGER_DOOR_MESSAGE);
		expect(message).not.toBe(ALLOCATION_DOOR_MESSAGE);
	});

	it("rejects a non-finite opts.allocated before running fn", () => {
		let ran = false;
		expect(() =>
			withCostCenter(
				"cc",
				() => {
					ran = true;
				},
				{ allocated: Number.NaN, periodStartMs: 1000 },
			),
		).toThrow(/allocated/);
		expect(ran).toBe(false);
	});

	it("rejects a negative opts.allocated before running fn", () => {
		let ran = false;
		expect(() =>
			withCostCenter(
				"cc",
				() => {
					ran = true;
				},
				{ allocated: -1, periodStartMs: 1000 },
			),
		).toThrow(/allocated/);
		expect(ran).toBe(false);
	});

	it("rejects a non-finite opts.periodStartMs before running fn", () => {
		let ran = false;
		expect(() =>
			withCostCenter(
				"cc",
				() => {
					ran = true;
				},
				{ allocated: 100, periodStartMs: Number.POSITIVE_INFINITY },
			),
		).toThrow(/periodStartMs/);
		expect(ran).toBe(false);
	});

	it("rejects a non-finite opts.periodEndMs when present, before running fn", () => {
		let ran = false;
		expect(() =>
			withCostCenter(
				"cc",
				() => {
					ran = true;
				},
				{ allocated: 100, periodStartMs: 1000, periodEndMs: Number.NaN },
			),
		).toThrow(/periodEndMs/);
		expect(ran).toBe(false);
	});

	it("accepts allocated === 0 (no headroom is a legal envelope, not an invalid one)", () => {
		const result = withCostCenter("cc", () => "ok", { allocated: 0, periodStartMs: 1000 });
		expect(result).toBe("ok");
	});
});

describe("withCostCenter — sync and async return values", () => {
	it("returns fn()'s synchronous return value", () => {
		const result = withCostCenter("cc", () => 42);
		expect(result).toBe(42);
	});

	it("returns fn()'s resolved value when fn is async", async () => {
		const result = await withCostCenter("cc", async () => {
			await Promise.resolve();
			return "done";
		});
		expect(result).toBe("done");
	});

	it("getCurrentCostCenter sees the active scope synchronously, and undefined outside it", () => {
		expect(getCurrentCostCenter()).toBeUndefined();
		withCostCenter("sync-cc", () => {
			expect(getCurrentCostCenter()?.costCenter).toBe("sync-cc");
		});
		expect(getCurrentCostCenter()).toBeUndefined();
	});

	it("getCurrentCostCenter sees the active scope across an await", async () => {
		await withCostCenter("async-cc", async () => {
			expect(getCurrentCostCenter()?.costCenter).toBe("async-cc");
			await new Promise((r) => setTimeout(r, 0));
			expect(getCurrentCostCenter()?.costCenter).toBe("async-cc");
		});
		expect(getCurrentCostCenter()).toBeUndefined();
	});
});

describe("withCostCenter — nesting and concurrent isolation", () => {
	it("innermost scope wins; the outer scope is restored when the inner one exits", () => {
		withCostCenter("outer", () => {
			expect(getCurrentCostCenter()?.costCenter).toBe("outer");
			withCostCenter("inner", () => {
				expect(getCurrentCostCenter()?.costCenter).toBe("inner");
			});
			expect(getCurrentCostCenter()?.costCenter).toBe("outer");
		});
	});

	it("Promise.all — two interleaved scopes never observe each other's costCenter", async () => {
		const seenA: Array<string | undefined> = [];
		const seenB: Array<string | undefined> = [];

		const taskA = withCostCenter("scope-a", async () => {
			seenA.push(getCurrentCostCenter()?.costCenter);
			await new Promise((r) => setTimeout(r, 10));
			seenA.push(getCurrentCostCenter()?.costCenter);
			await new Promise((r) => setTimeout(r, 0));
			seenA.push(getCurrentCostCenter()?.costCenter);
		});
		const taskB = withCostCenter("scope-b", async () => {
			seenB.push(getCurrentCostCenter()?.costCenter);
			await new Promise((r) => setTimeout(r, 0));
			seenB.push(getCurrentCostCenter()?.costCenter);
			await new Promise((r) => setTimeout(r, 10));
			seenB.push(getCurrentCostCenter()?.costCenter);
		});

		await Promise.all([taskA, taskB]);

		expect(seenA).toEqual(["scope-a", "scope-a", "scope-a"]);
		expect(seenB).toEqual(["scope-b", "scope-b", "scope-b"]);
	});
});

describe("withCostCenter — the emitter-tick hazard (pins WHY governors must capture at authorize)", () => {
	it("a listener registered inside a scope sees undefined when emitted after the scope exits", () => {
		const emitter = new EventEmitter();
		let seen: string | undefined = "sentinel-never-overwritten";

		withCostCenter("emitter-cc", () => {
			emitter.on("tick", () => {
				seen = getCurrentCostCenter()?.costCenter;
			});
		});

		// The scope has already exited by the time emit() runs — emit() executes
		// listeners synchronously in ITS OWN context, not the on()-registration
		// context, so the listener must not see "emitter-cc" here.
		expect(getCurrentCostCenter()).toBeUndefined();
		emitter.emit("tick");
		expect(seen).toBeUndefined();
	});
});

describe("withCostCenter — timers/microtasks scheduled INSIDE the scope still propagate", () => {
	it("queueMicrotask scheduled inside the scope sees the store when it runs", async () => {
		let seen: string | undefined;
		let resolveDone: () => void = () => {};
		const done = new Promise<void>((r) => {
			resolveDone = r;
		});

		withCostCenter("microtask-cc", () => {
			queueMicrotask(() => {
				seen = getCurrentCostCenter()?.costCenter;
				resolveDone();
			});
		});

		await done;
		expect(seen).toBe("microtask-cc");
	});

	it("setTimeout scheduled inside the scope sees the store when it fires", async () => {
		let seen: string | undefined;
		let resolveDone: () => void = () => {};
		const done = new Promise<void>((r) => {
			resolveDone = r;
		});

		withCostCenter("timer-cc", () => {
			setTimeout(() => {
				seen = getCurrentCostCenter()?.costCenter;
				resolveDone();
			}, 0);
		});

		await done;
		expect(seen).toBe("timer-cc");
	});
});

describe("withCostCenter — store restoration on failure (A4)", () => {
	it("restores the outer store after fn throws synchronously", () => {
		withCostCenter("outer", () => {
			expect(() =>
				withCostCenter("inner", () => {
					throw new Error("boom-sync");
				}),
			).toThrow("boom-sync");
			expect(getCurrentCostCenter()?.costCenter).toBe("outer");
		});
		expect(getCurrentCostCenter()).toBeUndefined();
	});

	it("restores the outer store after fn's returned promise rejects", async () => {
		await withCostCenter("outer", async () => {
			expect(getCurrentCostCenter()?.costCenter).toBe("outer");
			await expect(
				withCostCenter("inner", async () => {
					throw new Error("boom-async");
				}),
			).rejects.toThrow("boom-async");
			expect(getCurrentCostCenter()?.costCenter).toBe("outer");
		});
		expect(getCurrentCostCenter()).toBeUndefined();
	});
});

describe("withCostCenter — the store is frozen", () => {
	it("a mutation attempt on the returned store throws and does not leak across reads", () => {
		withCostCenter("frozen-cc", () => {
			const store = getCurrentCostCenter();
			expect(store).toBeDefined();
			expect(Object.isFrozen(store)).toBe(true);
			expect(() => {
				// @ts-expect-error — exercising the runtime freeze against a caller ignoring `readonly`
				store.costCenter = "hijacked";
			}).toThrow(TypeError);

			const reread = getCurrentCostCenter();
			expect(reread?.costCenter).toBe("frozen-cc");
		});
	});
});

describe("withCostCenter — opts (D4) are carried onto the store", () => {
	it("carries allocated/periodStartMs/periodEndMs when opts is present", () => {
		withCostCenter(
			"cc-with-opts",
			() => {
				const store = getCurrentCostCenter();
				expect(store).toEqual({
					costCenter: "cc-with-opts",
					allocated: 500,
					periodStartMs: 1_700_000_000_000,
					periodEndMs: 1_700_003_600_000,
				});
			},
			{ allocated: 500, periodStartMs: 1_700_000_000_000, periodEndMs: 1_700_003_600_000 },
		);
	});

	it("carries opts without a periodEndMs (open-ended period)", () => {
		withCostCenter(
			"cc-open-ended",
			() => {
				const store = getCurrentCostCenter();
				expect(store?.allocated).toBe(10);
				expect(store?.periodStartMs).toBe(5000);
				expect(store?.periodEndMs).toBeUndefined();
			},
			{ allocated: 10, periodStartMs: 5000 },
		);
	});

	it("omits allocated/periodStartMs/periodEndMs from the store when opts is absent", () => {
		withCostCenter("cc-no-opts", () => {
			const store = getCurrentCostCenter();
			expect(store?.costCenter).toBe("cc-no-opts");
			expect(store?.allocated).toBeUndefined();
			expect(store?.periodStartMs).toBeUndefined();
			expect(store?.periodEndMs).toBeUndefined();
		});
	});
});
