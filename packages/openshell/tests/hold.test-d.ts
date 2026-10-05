// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Usertools, Inc.

/**
 * Type-level test (#173): a Hold is read-only to the type checker, deeply, as it is frozen at
 * runtime. Checked by `tsc -p packages/openshell/tsconfig.type-tests.json` (root `typecheck`);
 * each `@ts-expect-error` FAILS the check if its write ever compiles.
 */

import type { Hold } from "../src/gate.js";

declare const hold: Hold;

// @ts-expect-error — the amount a hold reserves cannot be reassigned
hold.amount = 1;
// @ts-expect-error — nor its rates object
hold.rates = { inputPer1k: 0, outputPer1k: 0 };
// @ts-expect-error — nor a rate inside it (deep)
hold.rates.inputPer1k = 0;
// @ts-expect-error — nor its bound
hold.inputTokenBound = 0;

// Reads still compile.
export const read: number = hold.amount + hold.rates.inputPer1k;
