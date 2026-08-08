/**
 * Exhibit G tuning constant. Lives in app/components/sections/lib — outside
 * the check-facts prebuild gate's line-by-line scan of
 * app/components/sections/*.tsx — so the attack-row reveal stagger is a real
 * named constant, never a digit literal in marketing JSX. Same pattern as
 * app/lib/leader-path.ts's DRAW_STAGGER_MS and this directory's
 * exhibit-f-policy.ts's DROP_STAGGER_MS.
 */
export const ROW_STAGGER_MS = 40;
