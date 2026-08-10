/*
 * Tear-off motion tuning — kept out of tear-off.tsx because check-facts scans
 * every line of app/components/sections/*.tsx for un-sanctioned digit
 * literals, and a spring's stiffness/damping and the tear's latch delay are
 * motion tuning, not a product fact. lib/ files are outside that scan
 * (established pattern: exhibit-g-corpus.ts, exhibit-f-policy.ts).
 */
import type { Transition } from "motion/react";

export const TEAR_LATCH_MS = 300;

export const TEAR_SPRING: Transition = { type: "spring", stiffness: 420, damping: 26 };
