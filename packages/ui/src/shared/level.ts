// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * What the share window shows for the dimension the reader chose: the level, its words, and the role caption. Pure.
 *
 * A dimension is shown as itself, except Provider: a single provider's 100% ring says nothing, so the level follows it
 * down to its models, and a single model down to its lanes.
 */

import {
	type Dimension,
	keyOf,
	type SpendWindow,
	spendInWindow,
	WHOLE_VAULT,
} from "./breakdown.js";
import { providerOf } from "./provider.js";
import { JOB_TYPE_CAVEAT, type LedgerRow, typeSourceOf, UNTYPED } from "./rows.js";

/** The dimensions, in the switch's order (Lane is the default). */
export const DIMENSIONS: readonly Dimension[] = ["lane", "role", "model", "kind", "provider"];

/** The switch's labels. */
export const DIMENSION_LABEL: Readonly<Record<Dimension, string>> = {
	lane: "Lane",
	role: "Role (declared)",
	model: "Model",
	kind: "Kind",
	provider: "Provider",
};

/** One category of a level, in a count ("1 lane", "3 lanes"). */
export const LEVEL_NOUN: Readonly<Record<Dimension, string>> = {
	lane: "lane",
	role: "role",
	model: "model",
	kind: "kind",
	provider: "provider",
};

/** The window's subtitle at each level. */
export const LEVEL_SUBTITLE: Readonly<Record<Dimension, string>> = {
	lane: "lanes",
	role: "roles (declared)",
	model: "models",
	kind: "kinds",
	provider: "providers",
};

/** The subtitle's first word when Provider has followed one provider down: "Models · <provider>", "Lanes · <model>". */
export const SUBTITLE_DRILL = { model: "Models", lane: "Lanes" } as const;

export interface EffectiveLevel {
	dim: Dimension;
	adapted: boolean;
}

/**
 * The level the window breaks spend down by. Any dimension but Provider is itself. Provider, over the spend in `win`
 * (all time when omitted): two or more providers stay providers; else two or more models give models; else lanes. With
 * no spend it stays providers, unadapted: there is nothing to follow down.
 *
 * `rows` must be the rows under every filter except the models one, so a model picked at the models level keeps that
 * level (seen in proportion); `win` the window the drawn rows are read over, so the level is the one they have.
 */
export function effectiveLevel(
	dim: Dimension,
	rows: readonly LedgerRow[],
	win: SpendWindow = WHOLE_VAULT,
): EffectiveLevel {
	if (dim !== "provider") return { dim, adapted: false };
	let provider: string | null = null;
	let model: string | null = null;
	let models = 0;
	for (const row of rows) {
		if (spendInWindow(row, win) === undefined) continue;
		const p = providerOf(row);
		if (provider === null) provider = p;
		else if (p !== provider) return { dim: "provider", adapted: false };
		const m = keyOf("model", row);
		if (model === null) {
			model = m;
			models = 1;
		} else if (m !== model) models = 2;
	}
	if (provider === null) return { dim: "provider", adapted: false };
	return { dim: models > 1 ? "model" : "lane", adapted: true };
}

/**
 * What a drilled level is scoped to: at models, the provider of the first spend in `win`; at lanes, its model
 * (`"unknown"` only for a real record that has no model). Null when the level was not followed down or the window
 * holds no spend.
 */
export function scopeOf(
	dim: Dimension,
	level: Dimension,
	rows: readonly LedgerRow[],
	win: SpendWindow = WHOLE_VAULT,
): string | null {
	if (dim !== "provider" || (level !== "model" && level !== "lane")) return null;
	const first = rows.find((row) => spendInWindow(row, win) !== undefined);
	if (level === "model") return first === undefined ? null : providerOf(first);
	return first === undefined ? null : keyOf("model", first);
}

/** The window's subtitle, from `LEVEL_SUBTITLE` and `SUBTITLE_DRILL` only. */
export function levelSubtitle(dim: Dimension, level: Dimension, scope: string | null): string {
	if (dim === "provider" && (level === "model" || level === "lane")) {
		const drill = SUBTITLE_DRILL[level];
		return scope === null ? drill : `${drill} · ${scope}`;
	}
	return LEVEL_SUBTITLE[level];
}

/** Who declared the roles of the spend in `win`: spend-bearing rows counted by `typeSourceOf`. */
export function roleSources(rows: readonly LedgerRow[], win: SpendWindow): Map<string, number> {
	const out = new Map<string, number>();
	for (const row of rows) {
		if (spendInWindow(row, win) === undefined) continue;
		const source = typeSourceOf(row);
		out.set(source, (out.get(source) ?? 0) + 1);
	}
	return out;
}

/** The source `explicit` is the caller's own declaration. */
const CALLER = "caller";

/**
 * The caption under a roles breakdown: roles are declared, not checked. When any role was declared by someone other
 * than the caller, the sources are named, sorted (`explicit` as `caller`; records with no role left out).
 */
export function roleCaption(sources: ReadonlyMap<string, number>): string {
	const named = [...sources]
		.filter(([source, n]) => n > 0 && source !== UNTYPED)
		.map(([source]) => (source === "explicit" ? CALLER : source));
	if (named.every((source) => source === CALLER)) return `Roles as ${JOB_TYPE_CAVEAT}`;
	const unchecked = JOB_TYPE_CAVEAT.replace(` by the ${CALLER}`, "");
	return `Roles as ${unchecked} · source: ${named.sort().join(", ")}`;
}
