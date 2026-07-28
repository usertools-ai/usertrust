// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

import * as usertrust from "usertrust";
import { describe, expect, it } from "vitest";

/**
 * The runtime half of the F1 guard; `public-budget-api.test-d.ts` covers the
 * emitted `dist` types. `allocateBudget`, `reclaimBudget` and `getBudgetStatus`
 * all require a `TrustTBClient` as their first argument, so re-exporting them
 * without the class ships an API no consumer can call. Asserting the value
 * binding — not just the type — is what rules out a `export type { ... }`
 * re-export, which would type-check while leaving nothing to construct.
 *
 * The namespace import is deliberate: a named import of a missing export is an
 * ESM link error, which fails the whole file instead of this assertion.
 */
describe("public budget API surface", () => {
	it("exports the budget entry points from the package root", () => {
		expect(typeof usertrust.allocateBudget).toBe("function");
		expect(typeof usertrust.reclaimBudget).toBe("function");
		expect(typeof usertrust.getBudgetStatus).toBe("function");
	});

	it("exports the TrustTBClient those entry points require as a constructible value", () => {
		expect(typeof usertrust.TrustTBClient).toBe("function");
		expect(typeof usertrust.TrustTBClient?.prototype).toBe("object");
	});
});
