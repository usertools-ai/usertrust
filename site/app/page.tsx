import { BeforeAfter } from "./components/before-after";
import { BuiltFor } from "./components/built-for";
import { BYOK } from "./components/byok";
import { CodeExample } from "./components/code-example";
import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { GradientOrbs } from "./components/gradient-orbs";
import { GridBackground } from "./components/grid-background";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";
import { Nav } from "./components/nav";
import { SocialProof } from "./components/social-proof";

const fmtCount = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

// Fetched once on the server and cached (ISR, 1h). Keeps the npm/GitHub calls off
// the client critical path — no render-after-paint layout shift, and the GitHub
// call runs from the deploy region instead of every visitor's rate-limited IP.
async function getPackageStats(): Promise<{ downloads: string; stars: string }> {
	let downloads = "—";
	let stars = "—";
	try {
		const r = await fetch("https://api.npmjs.org/downloads/point/last-month/usertrust", {
			next: { revalidate: 3600 },
		});
		if (r.ok) {
			const n = (await r.json())?.downloads;
			if (typeof n === "number") downloads = fmtCount(n);
		}
	} catch {}
	try {
		const r = await fetch("https://api.github.com/repos/usertools-ai/usertrust", {
			next: { revalidate: 3600 },
			headers: { Accept: "application/vnd.github+json", "User-Agent": "usertrust-site" },
		});
		if (r.ok) {
			const n = (await r.json())?.stargazers_count;
			if (typeof n === "number") stars = fmtCount(n);
		}
	} catch {}
	return { downloads, stars };
}

export default async function Home() {
	const { downloads, stars } = await getPackageStats();
	return (
		<>
			<GridBackground />
			<GradientOrbs />
			<Nav />
			<Hero downloads={downloads} stars={stars} />
			<SocialProof />
			<CodeExample />
			<BeforeAfter />
			<Features />
			<HowItWorks />
			<BYOK />
			<BuiltFor />
			<CTA />
			<Footer />
		</>
	);
}
