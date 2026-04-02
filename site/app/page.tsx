import { BeforeAfter } from "./components/before-after";
import { BYOK } from "./components/byok";
import { CodeExample } from "./components/code-example";
import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { GridBackground } from "./components/grid-background";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";
import { Nav } from "./components/nav";
import { SocialProof } from "./components/social-proof";

export default function Home() {
	return (
		<>
			<GridBackground />
			<Nav />
			<Hero />
			<SocialProof />
			<CodeExample />
			<BeforeAfter />
			<Features />
			<HowItWorks />
			<BYOK />
			<CTA />
			<Footer />
		</>
	);
}
