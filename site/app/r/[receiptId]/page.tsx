import { verifyPageMetadata } from "../lib/metadata";
import { resolveVerifyPageState } from "../lib/resolve";
import { shellHeadline } from "../lib/shell-copy";

/**
 * `/r/<receiptId>` — what a `Usertrust-Receipt` trailer resolves to (spec
 * §9). This task (route + transport, D1/D2) owns getting a trustworthy
 * `PageState` onto the page and rendering it HONESTLY; the full visual
 * language for each rung/state (§6 anatomy, the §7 copy matrix) belongs to
 * Tasks 4 and 5, which replace the `<Shell>` below wholesale. Nothing here
 * claims to be the finished page.
 */

// Forces dynamic, per-request rendering (D1): the SSR fetch below is
// `no-store`, and a statically-optimized or ISR'd `/r/*` page would defeat
// the resolver's own caching contract by serving a stale answer regardless
// of what the fetch option says.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

interface PageProps {
	params: Promise<{ receiptId: string }>;
}

/**
 * `noindex` — the route ships DARK (plan §"Global Constraints": "unlinked,
 * `noindex`, behind the resolver-live gate"). Nothing in the site nav links
 * here, and this is the other half: a crawler that finds the URL anyway is
 * told not to index it.
 */
export const metadata = verifyPageMetadata;

export default async function VerifyReceiptPage({ params }: PageProps) {
	const { receiptId } = await params;
	const state = await resolveVerifyPageState(receiptId);

	return (
		<main>
			<Shell state={state} />
		</main>
	);
}

/**
 * The interim, Task-3-scoped render: enough that every {@link PageState}
 * kind produces honest, distinctly-labeled output (never a silent blank
 * page, never one state's copy leaking into another's), without building
 * the §6 design system this task does not own.
 */
function Shell({ state }: { state: Awaited<ReturnType<typeof resolveVerifyPageState>> }) {
	const headline = shellHeadline(state);
	return (
		<section data-state={state.kind}>
			<h1>{headline}</h1>
			{"reason" in state ? <p>{state.reason}</p> : null}
			{"detail" in state ? <p>{state.detail}</p> : null}
		</section>
	);
}
