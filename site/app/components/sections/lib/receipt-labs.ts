/**
 * Model-lab identity for the Exhibit A receipt switcher (Addendum J2/J3).
 *
 * Two things live here and nowhere else:
 *
 *  1. The display label for each captured model id. Every one of them carries a
 *     digit ("Fable 5", "GPT 5.6 Sol", "Kimi K3"), and check-facts scans every
 *     line of `sections/*.tsx` — so the strings live in this `.ts` lib and the
 *     JSX renders `{panel.label}`. Same construction as
 *     `sections/intro-video-sources.ts` and `lib/leader-path.ts`: move the
 *     digits out of the scanned surface rather than loosen the gate.
 *
 *  2. The lab's mark. Anthropic's and OpenAI's paths are the ones already in
 *     provider-logos.ts — imported, never re-pasted, so a correction to either
 *     reaches both surfaces. Moonshot AI's is added here from the same source
 *     (simple-icons, CC0 1.0, retrieved 2026-08-09). Marks are nominative use:
 *     monochrome, ghosted, sized to the receipt chrome, no endorsement implied.
 *
 * The LAB is the organisation that trained the model. It is NOT the receipt's
 * `provider` field, which records what `detectClientKind` matched — Kimi ships
 * an OpenAI-compatible API, so its receipt honestly says "openai" while its lab
 * mark says Moonshot AI. The page shows both; it never quietly reconciles them.
 */
import { PROVIDER_LOGOS, PROVIDER_VIEWBOX } from "./provider-logos";

export const LAB_VIEWBOX = PROVIDER_VIEWBOX;

/** simple-icons "moonshotai" (CC0 1.0), retrieved 2026-08-09. viewBox 0 0 24 24. */
const MOONSHOT_PATH =
	"m1.053 16.91 9.538 2.55a21 20.981 0 0 0 .06 2.031l5.956 1.592a12 11.99 0 0 1-15.554-6.172m-1.02-5.79 11.352 3.035a21 20.981 0 0 0-.469 2.01l10.817 2.89a12 11.99 0 0 1-1.845 2.004L.658 15.918a12 11.99 0 0 1-.625-4.796m1.593-5.146L13.573 9.17a21 20.981 0 0 0-1.01 1.874l11.297 3.02a21 20.981 0 0 1-.67 2.362l-11.55-3.087L.125 10.26a12 11.99 0 0 1 1.499-4.285ZM6.067 1.58l11.285 3.016a21 20.981 0 0 0-1.688 1.719l7.824 2.091a21 20.981 0 0 1 .513 2.664L2.107 5.218a12 11.99 0 0 1 3.96-3.638M21.68 4.866 7.222 1.003A12 11.99 0 0 1 21.68 4.866";

function providerPath(name: string): string {
	const hit = PROVIDER_LOGOS.find((l) => l.name === name);
	if (!hit) throw new Error(`provider-logos.ts has no mark named "${name}"`);
	return hit.path;
}

export interface ModelLab {
	/** Tab label — short enough for three tabs on a phone. */
	label: string;
	/** The organisation that trained the model. */
	lab: string;
	/** simple-icons path for the lab's mark, or null for the text-badge register. */
	mark: string | null;
}

const LABS: Record<string, ModelLab> = {
	"claude-fable-5": { label: "Fable 5", lab: "Anthropic", mark: providerPath("Anthropic") },
	"gpt-5.6-sol": { label: "GPT 5.6 Sol", lab: "OpenAI", mark: providerPath("OpenAI") },
	"kimi-k3": { label: "Kimi K3", lab: "Moonshot AI", mark: MOONSHOT_PATH },
};

/**
 * Lab identity for a captured model id.
 *
 * An unknown id falls back to the id itself with NO mark — a captured model the
 * page has no identity for renders as its own honest string rather than
 * borrowing somebody else's logo.
 */
export function labFor(modelId: string): ModelLab {
	return LABS[modelId] ?? { label: modelId, lab: modelId, mark: null };
}
