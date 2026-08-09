/**
 * Coordinate tables for THE GOVERNANCE DIE (exhibit-b-die.tsx).
 *
 * These are SVG user-space coordinates in the die's 900x700 viewBox, not
 * product numbers — but check-facts scans every line of `sections/*.tsx`,
 * comments and array literals included, and an array of bare integers is
 * indistinguishable from a marketing claim to a line-based scan. So the
 * geometry lives in a `.ts` lib, exactly as `intro-video-sources.ts` and
 * `provider-logos.ts` do. Moving the digits out is the fix; loosening the gate
 * is not.
 */

/** X positions of the pin stubs along the die's top and bottom edges. */
export const DIE_PIN_X = [492, 524, 556, 588, 620] as const;

/** Y positions of the fine trace field feeding the die's left edge. */
export const DIE_FEED_Y = [186, 222, 258, 442, 478, 514] as const;

/** Y at which a feed trace turns: above it routes to the upper edge port. */
export const DIE_FEED_SPLIT_Y = 350;

/** Where a feed trace lands on the die's left edge, upper and lower ports. */
export const DIE_FEED_PORT_UPPER = 300;
export const DIE_FEED_PORT_LOWER = 400;

/** Half-width of a square pad, and the pad's y offsets on each edge. */
export const DIE_PAD_HALF = 4;
export const DIE_PAD_SIZE = 8;
export const DIE_PAD_TOP_Y = 218;
export const DIE_PAD_BOTTOM_Y = 474;

/** Feed-trace start x, and the x of the die's left edge the feeds reach. */
export const DIE_FEED_START_X = 150;
export const DIE_FEED_TURN_X = 400;
export const DIE_FEED_END_X = 458;

/** Radius of the small pads that terminate the fine trace field. */
export const DIE_FEED_PAD_R = 3;

/** Pin-stub endpoints on the die's top and bottom edges. */
export const DIE_PIN_TOP_FROM = 250;
export const DIE_PIN_TOP_TO = 226;
export const DIE_PIN_BOTTOM_FROM = 450;
export const DIE_PIN_BOTTOM_TO = 474;
