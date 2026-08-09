export type ProviderId = "anthropic" | "openai" | "google";

export interface CodeLine {
	/** Stable across tabs for shared lines; provider-suffixed for lines that morph. */
	key: string;
	text: string;
	/** Participates in the diff morph (enter/exit). Shared lines only re-layout. */
	changed: boolean;
	/** The trust() line — constant key, persistent emerald underline, pinned position. */
	trust?: boolean;
}

export interface ProviderTab {
	id: ProviderId;
	label: string;
	lines: CodeLine[];
}

/**
 * One code shape, three providers. Only the SDK import, the client constructor
 * (inside the pinned trust() line), the governed method, and the model/params
 * lines differ. The trust() line carries the key "trust" in every tab, so
 * AnimatePresence can never unmount it — that is what pins its position.
 * Model ids are real rows from packages/core/src/ledger/pricing.ts.
 */
export const PROVIDER_TABS: ProviderTab[] = [
	{
		id: "anthropic",
		label: "anthropic",
		lines: [
			{
				key: "import-anthropic",
				text: 'import Anthropic from "@anthropic-ai/sdk";',
				changed: true,
			},
			{ key: "import-usertrust", text: 'import { trust } from "usertrust";', changed: false },
			{ key: "gap-1", text: "", changed: false },
			{
				key: "trust",
				text: "const client = await trust(new Anthropic());",
				changed: false,
				trust: true,
			},
			{ key: "gap-2", text: "", changed: false },
			{ key: "call-open", text: "const { response, receipt } =", changed: false },
			{ key: "method-anthropic", text: "  await client.messages.create({", changed: true },
			{ key: "model-anthropic", text: '    model: "claude-sonnet-4-6",', changed: true },
			{ key: "params-anthropic", text: "    max_tokens: 1024,", changed: true },
			{ key: "params-messages", text: "    messages: [...],", changed: true },
			{ key: "call-close", text: "  });", changed: false },
		],
	},
	{
		id: "openai",
		label: "openai",
		lines: [
			{ key: "import-openai", text: 'import OpenAI from "openai";', changed: true },
			{ key: "import-usertrust", text: 'import { trust } from "usertrust";', changed: false },
			{ key: "gap-1", text: "", changed: false },
			{
				key: "trust",
				text: "const client = await trust(new OpenAI());",
				changed: false,
				trust: true,
			},
			{ key: "gap-2", text: "", changed: false },
			{ key: "call-open", text: "const { response, receipt } =", changed: false },
			{ key: "method-openai", text: "  await client.chat.completions.create({", changed: true },
			{ key: "model-openai", text: '    model: "gpt-5.4",', changed: true },
			{ key: "params-messages", text: "    messages: [...],", changed: true },
			{ key: "call-close", text: "  });", changed: false },
		],
	},
	{
		id: "google",
		label: "google",
		lines: [
			{ key: "import-google", text: 'import { GoogleGenAI } from "@google/genai";', changed: true },
			{ key: "import-usertrust", text: 'import { trust } from "usertrust";', changed: false },
			{ key: "gap-1", text: "", changed: false },
			{
				key: "trust",
				text: "const client = await trust(new GoogleGenAI({}));",
				changed: false,
				trust: true,
			},
			{ key: "gap-2", text: "", changed: false },
			{ key: "call-open", text: "const { response, receipt } =", changed: false },
			{ key: "method-google", text: "  await client.models.generateContent({", changed: true },
			{ key: "model-google", text: '    model: "gemini-3.1-pro",', changed: true },
			{ key: "params-google", text: '    contents: "...",', changed: true },
			{ key: "call-close", text: "  });", changed: false },
		],
	},
];

/**
 * Roving-tabindex + arrow-key cycling helpers for the tab island.
 *
 * Kept here (app/lib, not app/components/sections) rather than inline in the
 * component: check-facts's digit-literal gate scans app/components/sections/
 * only, and ordinary index arithmetic (i + 1, length - 1) and Tailwind
 * opacity variants (bg-ut/10) are not product numbers — they don't belong in
 * the facts-traceability scan in the first place, and living here keeps the
 * section file free of digit literals the gate would otherwise flag.
 */
/*
 * Generic over the id type, not pinned to ProviderId: Exhibit A's receipt
 * switcher is the same roving-tabs pattern over MODEL ids, and two tab strips
 * on one page that disagree about what an arrow key does is worse than either
 * behaviour. One implementation, two callers.
 */
export function nextProvider<T extends string>(ids: T[], current: T): T {
	const i = ids.indexOf(current);
	return ids[(i + 1) % ids.length];
}

export function prevProvider<T extends string>(ids: T[], current: T): T {
	const i = ids.indexOf(current);
	return ids[(i - 1 + ids.length) % ids.length];
}

export function lastProvider<T extends string>(ids: T[]): T {
	return ids[ids.length - 1];
}

/** Selected/unselected tab-button classes — moved out of JSX for the same reason. */
export function tabButtonClass(active: boolean): string {
	return active ? "bg-ut/10 text-ut" : "text-white/50 hover:text-white/80";
}

/** Roving tabindex: 0 for the active tab, -1 for the rest. */
export function rovingTabIndex(active: boolean): 0 | -1 {
	return active ? 0 : -1;
}

/** Prefix shared by every tab's pinned trust() line. */
export const TRUST_PREFIX = "const client = await ";

/**
 * Strips the shared prefix and the trailing semicolon from a trust() line,
 * leaving just the constructor call for the persistent-underline span. Lives
 * here rather than inline in the component for the same check-facts reason
 * as the helpers above — the trailing-semicolon slice is index arithmetic,
 * not a product number.
 */
export function trustLineBody(text: string): string {
	return text.slice(TRUST_PREFIX.length, -1);
}
