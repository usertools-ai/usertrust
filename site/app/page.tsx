import { GridBackground } from "./components/grid-background";
import { Nav } from "./components/nav";
import Docket from "./components/sections/docket";
import ExhibitA from "./components/sections/exhibit-a";
import ExhibitB from "./components/sections/exhibit-b";
import ExhibitC from "./components/sections/exhibit-c";
import ExhibitD from "./components/sections/exhibit-d";
import ExhibitE from "./components/sections/exhibit-e";
import ExhibitF from "./components/sections/exhibit-f";
import ExhibitG from "./components/sections/exhibit-g";
import HardenStrip from "./components/sections/harden-strip";
import Hero from "./components/sections/hero";
import LedgerTicker from "./components/sections/ledger-ticker";
import OpenLedger from "./components/sections/open-ledger";

/*
 * Fetched once on the server, ISR 1h. Parallelized with a hard 2s timeout per
 * call so a slow upstream can never stall the render, and failures resolve to
 * null — the Nav omits a null counter entirely rather than showing 0.
 */
async function getPackageStats(): Promise<{ stars: number | null; downloads: number | null }> {
	const [downloads, stars] = await Promise.all([
		fetch("https://api.npmjs.org/downloads/point/last-month/usertrust", {
			next: { revalidate: 3600 },
			signal: AbortSignal.timeout(2000),
		})
			.then(async (r) => (r.ok ? ((await r.json()).downloads as number) : null))
			.catch(() => null),
		fetch("https://api.github.com/repos/usertools-ai/usertrust", {
			next: { revalidate: 3600 },
			headers: { Accept: "application/vnd.github+json" },
			signal: AbortSignal.timeout(2000),
		})
			.then(async (r) => (r.ok ? ((await r.json()).stargazers_count as number) : null))
			.catch(() => null),
	]);
	return { downloads, stars };
}

export default async function Home() {
	const { stars, downloads } = await getPackageStats();
	return (
		<>
			<GridBackground />
			<Nav stars={stars} downloads={downloads} />
			<Hero />
			<Docket />
			<ExhibitA />
			<ExhibitB />
			<ExhibitC />
			<ExhibitD />
			<ExhibitE />
			<ExhibitF />
			<ExhibitG />
			<HardenStrip />
			{/* Addendum O — the chain keeps running between the doctrine and the
			    closing panel. Not a section[id]: it is not a nav destination. */}
			<LedgerTicker />
			<OpenLedger />
		</>
	);
}
