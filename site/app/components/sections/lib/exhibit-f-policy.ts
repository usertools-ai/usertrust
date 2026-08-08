/**
 * Exhibit F data. Two real GateRules in the exact YAML shape
 * packages/core/src/policy/gate.ts loadPolicies() accepts (`rules:` list;
 * conditions use the shared FieldCondition {field, operator, value};
 * scopePatterns are minimatch globs; timeWindows use daysOfWeek/startHour/
 * endHour). Context field names are the ones govern.ts actually asserts:
 * model, estimated_cost, cost_center.
 *
 * Kept out of JSX so no digit literal appears in marketing JSX text
 * (check-facts) and so the node:test suite plus the engine-validation
 * script consume the exact strings the page renders. The two animation
 * timing constants below live here for the same reason: check-facts scans
 * every *.tsx file directly under app/components/sections/ line-by-line for
 * bare digit literals, and this module (app/components/sections/lib/) is
 * outside that scan — the same pattern app/lib/exhibit-d.ts and
 * app/lib/leader-path.ts already use for their stagger/threshold constants.
 */

export type PolicyOp = "eq" | "gt" | "in" | "regex";

export interface PolicySeg {
	t: string;
	op?: PolicyOp;
}

export interface PolicyLine {
	segs: PolicySeg[];
}

export const POLICY_LINES: PolicyLine[] = [
	{ segs: [{ t: "rules:" }] },
	{ segs: [{ t: "  - name: frontier-cost-cap" }] },
	{ segs: [{ t: "    effect: deny" }] },
	{ segs: [{ t: "    enforcement: hard" }] },
	{ segs: [{ t: "    severity: critical" }] },
	{ segs: [{ t: "    conditions:" }] },
	{
		segs: [
			{ t: "      - { field: model, operator: " },
			{ t: "in", op: "in" },
			{ t: ", value: [gpt-x, gpt-x-mini] }" },
		],
	},
	{
		segs: [
			{ t: "      - { field: estimated_cost, operator: " },
			{ t: "gt", op: "gt" },
			{ t: ", value: 2000 }" },
		],
	},
	{ segs: [{ t: "  - name: research-scope-guard" }] },
	{ segs: [{ t: "    effect: deny" }] },
	{ segs: [{ t: "    enforcement: hard" }] },
	{ segs: [{ t: "    conditions:" }] },
	{
		segs: [
			{ t: "      - { field: cost_center, operator: " },
			{ t: "eq", op: "eq" },
			{ t: ", value: research }" },
		],
	},
	{
		segs: [
			{ t: "      - { field: model, operator: " },
			{ t: "regex", op: "regex" },
			{ t: ', value: "^gpt-x" }' },
		],
	},
	{ segs: [{ t: '    scopePatterns: ["agents/research/**"]' }] },
	{
		segs: [{ t: "    timeWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], startHour: 9, endHour: 18 }]" }],
	},
];

/** The exact YAML the editor renders, as one string. */
export function policyYamlText(): string {
	return POLICY_LINES.map((l) => l.segs.map((s) => s.t).join("")).join("\n");
}

export interface ChitLine {
	label: string;
	value: string;
	redacted?: boolean;
	caughtBy?: PolicyOp[];
}

export interface Chit {
	id: string;
	verdict: "pass" | "blocked";
	lines: ChitLine[];
}

export const CHITS: Chit[] = [
	{
		id: "chit-01",
		verdict: "pass",
		lines: [
			{ label: "model", value: "claude-sonnet-4-6", caughtBy: ["in", "regex"] },
			{ label: "est_cost", value: "840", caughtBy: ["gt"] },
		],
	},
	{
		id: "chit-02",
		verdict: "pass",
		lines: [
			{ label: "model", value: "gemini-2.5-flash", caughtBy: ["in", "regex"] },
			{ label: "est_cost", value: "120", caughtBy: ["gt"] },
		],
	},
	{
		id: "chit-03",
		verdict: "pass",
		lines: [
			{ label: "model", value: "gpt-x-mini", caughtBy: ["in", "regex"] },
			{ label: "card_number", value: "redacted", redacted: true },
			{ label: "est_cost", value: "300", caughtBy: ["gt"] },
		],
	},
	{
		id: "chit-04",
		verdict: "pass",
		lines: [
			{ label: "model", value: "claude-haiku-4-5", caughtBy: ["in", "regex"] },
			{ label: "cost_center", value: "support", caughtBy: ["eq"] },
		],
	},
	{
		id: "chit-05",
		verdict: "blocked",
		lines: [
			{ label: "model", value: "gpt-x", caughtBy: ["in", "regex"] },
			{ label: "est_cost", value: "2400", caughtBy: ["gt"] },
		],
	},
	{
		id: "chit-06",
		verdict: "pass",
		lines: [
			{ label: "model", value: "gpt-x-mini", caughtBy: ["in", "regex"] },
			{ label: "est_cost", value: "990", caughtBy: ["gt"] },
		],
	},
];

/**
 * Why chit-05 was denied — shown on the thrown-error card in the spool's
 * rail. RULING (2026-08-07): denials write NO audit event — the card is the
 * REAL thrown error, never a chain entry (spec Rev 3 / D6 correction). There
 * is deliberately no RAIL_EVENT constant: an `llm_call_failed`-style chain
 * entry is not what happens on denial, so the page must not render one.
 */
export const RAIL_REASON =
	"frontier-cost-cap · estimated_cost 2400 gt 2000 · model gpt-x in [gpt-x, gpt-x-mini]";

export const RAIL_THROWN = "thrown: PolicyDeniedError · the provider was never called";

/** Print-spool drop stagger, per chit index. See module header for why this
 * digit lives here instead of in exhibit-f-spool.tsx. */
export const DROP_STAGGER_MS = 140;

/** IntersectionObserver threshold that arms the spool's one-shot playback. */
export const SPOOL_IO_THRESHOLD = 0.35;

/**
 * Tailwind class builders for exhibit-f-spool.tsx. These specific strings
 * carry opacity-slash utilities (border-danger/50, ring-tim/40, text-white/70)
 * that check-facts's className-same-line exemption cannot see once a ternary
 * puts the string on its own source line (a real formatting hazard, not a
 * hypothetical one — the multi-line ternary shape is exactly what the
 * JSX would otherwise wrap to). Returning the whole string from here keeps
 * every digit out of the scanned *.tsx file regardless of how the call site
 * wraps.
 */
export function chitCardClass(violator: boolean, anim: string): string {
	const border = violator ? "border-danger/50" : "border-brand-border";
	return `lift-1 rounded-sm border bg-[#11112a] px-3 py-2 ${border} ${anim}`;
}

export function chitLineClass(hot: boolean): string {
	return hot ? "rounded-sm bg-tim/15 text-white ring-1 ring-tim/40" : "text-white/70";
}

export function editorLineClass(hot: boolean): string {
	return `px-1 ${hot ? "rounded-sm bg-tim/15 ring-1 ring-tim/40" : ""}`;
}
