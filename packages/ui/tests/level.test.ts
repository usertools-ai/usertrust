// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import type { Dimension } from "../src/shared/breakdown.js";
import {
	DIMENSION_LABEL,
	DIMENSIONS,
	effectiveLevel,
	LEVEL_NOUN,
	LEVEL_SUBTITLE,
	levelSubtitle,
	roleCaption,
	roleSources,
	SUBTITLE_DRILL,
	scopeOf,
} from "../src/shared/level.js";
import type { LedgerRow } from "../src/shared/rows.js";
import { rangeWindow } from "../src/shared/spend-series.js";

const DIMS: Dimension[] = ["lane", "role", "model", "kind", "provider"];

describe("effectiveLevel (no spend: the dimension unchanged)", () => {
	it("returns the dimension unchanged and not adapted, for every dimension", () => {
		for (const dim of DIMS) {
			expect(effectiveLevel(dim, [])).toEqual({ dim, adapted: false });
		}
	});

	it("takes the desk window as an optional third argument, with no spend in it", () => {
		const win = rangeWindow("1w", Date.parse("2026-11-07T12:00:00.000Z"));
		const rows: readonly LedgerRow[] = [];
		for (const dim of DIMS) {
			expect(effectiveLevel(dim, rows, win)).toEqual({ dim, adapted: false });
		}
	});
});

const T0 = Date.parse("2026-11-07T00:00:00.000Z");
const HOUR = 3_600_000;
const WIN = { startMs: T0, endMs: T0 + 24 * HOUR };

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
	return {
		seq: 1,
		pos: 0,
		id: "r",
		ts: new Date(T0 + HOUR).toISOString(),
		kind: "llm_call",
		actor: "ana",
		model: "claude-x",
		hash: "a".repeat(64),
		previousHash: "0".repeat(64),
		integrity: "verified",
		costUt: 5,
		...overrides,
	};
}

describe("level", () => {
	it("names the five dimensions in switch order, with their labels and nouns", () => {
		expect(DIMENSIONS).toEqual(["lane", "role", "model", "kind", "provider"]);
		expect(DIMENSIONS.map((d) => DIMENSION_LABEL[d])).toEqual([
			"Lane",
			"Role (declared)",
			"Model",
			"Kind",
			"Provider",
		]);
		expect(DIMENSIONS.map((d) => LEVEL_NOUN[d])).toEqual([
			"lane",
			"role",
			"model",
			"kind",
			"provider",
		]);
	});

	it("follows a provider down to its models, then to its lanes", () => {
		const anthropic = row();
		const xai = row({ model: "grok-4" });
		expect(effectiveLevel("provider", [anthropic, xai])).toEqual({
			dim: "provider",
			adapted: false,
		});
		expect(effectiveLevel("provider", [anthropic, row({ model: "claude-y" })])).toEqual({
			dim: "model",
			adapted: true,
		});
		expect(effectiveLevel("provider", [anthropic, row({ actor: "bo" })])).toEqual({
			dim: "lane",
			adapted: true,
		});
	});

	it("never adapts any other dimension", () => {
		for (const d of ["lane", "role", "model", "kind"] as const) {
			expect(effectiveLevel(d, [row()])).toEqual({ dim: d, adapted: false });
		}
	});

	it("reads only spend inside the window: a second provider outside it, or not spend, is ignored", () => {
		const rows = [
			row(),
			row({ model: "claude-y" }),
			row({ model: "grok-4", ts: new Date(WIN.endMs).toISOString() }),
			row({ model: "gpt-5", kind: "info" }),
		];
		expect(effectiveLevel("provider", rows, WIN)).toEqual({ dim: "model", adapted: true });
		expect(effectiveLevel("provider", rows).dim).toBe("provider");
	});

	it("words the subtitle from the two constants only", () => {
		expect(LEVEL_SUBTITLE).toEqual({
			lane: "lanes",
			role: "roles (declared)",
			model: "models",
			kind: "kinds",
			provider: "providers",
		});
		expect(SUBTITLE_DRILL).toEqual({ model: "Models", lane: "Lanes" });
		expect(levelSubtitle("provider", "model", "Anthropic")).toBe("Models · Anthropic");
		expect(levelSubtitle("provider", "lane", "claude-x")).toBe("Lanes · claude-x");
		expect(levelSubtitle("provider", "provider", null)).toBe("providers");
		expect(levelSubtitle("role", "role", null)).toBe("roles (declared)");
		expect(levelSubtitle("lane", "lane", null)).toBe("lanes");
		expect(levelSubtitle("model", "model", null)).toBe("models");
		expect(levelSubtitle("kind", "kind", null)).toBe("kinds");
	});

	it("scopes a drilled level to the provider, or the model, of the first spend in the window", () => {
		const rows = [row({ kind: "info", model: "gpt-5" }), row(), row({ model: "claude-y" })];
		expect(scopeOf("provider", "model", rows, WIN)).toBe("Anthropic");
		expect(scopeOf("provider", "lane", rows, WIN)).toBe("claude-x");
		const { model: _drop, ...noModel } = row();
		expect(scopeOf("provider", "lane", [noModel], WIN)).toBe("unknown");
		expect(scopeOf("provider", "lane", [], WIN)).toBe("unknown");
		expect(scopeOf("lane", "lane", rows, WIN)).toBeNull();
		expect(scopeOf("provider", "provider", rows, WIN)).toBeNull();
	});

	it("captions roles as declared, naming any source but the caller", () => {
		expect(
			roleCaption(
				new Map([
					["explicit", 3],
					["untyped", 1],
				]),
			),
		).toBe("Roles as declared by the caller, not checked");
		expect(
			roleCaption(
				new Map([
					["explicit", 3],
					["untyped", 1],
					["agent", 2],
				]),
			),
		).toBe("Roles as declared, not checked · source: agent, caller");
		expect(roleCaption(new Map())).toBe("Roles as declared by the caller, not checked");
	});

	it("counts role sources over spend-bearing rows inside the half-open window only", () => {
		const rows = [
			row({ jobType: "feature", typeSource: "explicit" }),
			row({ jobType: "feature", typeSource: "explicit", ts: new Date(T0).toISOString() }),
			row({ jobType: "bugfix", typeSource: "agent" }),
			row(),
			row({ jobType: "docs", typeSource: "agent", kind: "info" }),
			row({ jobType: "docs", typeSource: "agent", ts: new Date(WIN.endMs).toISOString() }),
			row({ jobType: "docs", typeSource: "agent", ts: new Date(T0 - 1).toISOString() }),
		];
		expect(roleSources(rows, WIN)).toEqual(
			new Map([
				["explicit", 2],
				["agent", 1],
				["untyped", 1],
			]),
		);
	});
});
