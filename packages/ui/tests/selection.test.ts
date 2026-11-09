// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import { describe, expect, it } from "vitest";
import { DIM_OPACITY, litState, type Selection } from "../src/shared/selection.js";

const sel = (dim: Selection["dim"], ...keys: string[]): Selection => ({
	dim,
	keys: new Set(keys),
});

describe("litState", () => {
	it("lights a selected key as selected", () => {
		expect(litState(sel("lane", "a"), null, "a")).toBe("selected");
	});

	it("dims every other key while one is selected", () => {
		expect(litState(sel("lane", "a"), null, "b")).toBe("dim");
	});

	it("leaves every key at rest when nothing is selected", () => {
		expect(litState(sel("lane"), null, "a")).toBe("rest");
		expect(litState(sel("lane"), null, "b")).toBe("rest");
	});

	it("lights a hovered key that is not selected while something else is", () => {
		expect(litState(sel("lane", "a"), { dim: "lane", key: "b" }, "b")).toBe("hover");
	});

	it("lights a hovered key when nothing is selected", () => {
		expect(litState(sel("lane"), { dim: "lane", key: "b" }, "b")).toBe("hover");
	});

	it("ignores a hover on another dimension", () => {
		expect(litState(sel("lane", "a"), { dim: "model", key: "b" }, "b")).toBe("dim");
		expect(litState(sel("lane"), { dim: "model", key: "b" }, "b")).toBe("rest");
	});

	it("keeps a hovered key that is also selected as selected", () => {
		expect(litState(sel("lane", "a"), { dim: "lane", key: "a" }, "a")).toBe("selected");
	});

	it("dims an unhovered key beside a hovered one", () => {
		expect(litState(sel("lane", "a"), { dim: "lane", key: "b" }, "c")).toBe("dim");
	});

	it("dims others to .3", () => {
		expect(DIM_OPACITY).toBe(0.3);
	});
});
