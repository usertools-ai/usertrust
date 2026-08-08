import { BeforeAfter } from "./components/before-after";
import { BuiltFor } from "./components/built-for";
import { BYOK } from "./components/byok";
import { CodeExample } from "./components/code-example";
import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { GridBackground } from "./components/grid-background";
import { HowItWorks } from "./components/how-it-works";
import { Nav } from "./components/nav";
import Docket from "./components/sections/docket";
import Hero from "./components/sections/hero";
import { SocialProof } from "./components/social-proof";

export default function Home() {
	return (
		<>
			<GridBackground />
			<Nav />
			<Hero />
			<Docket />
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
