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
import ExhibitA from "./components/sections/exhibit-a";
import ExhibitB from "./components/sections/exhibit-b";
import ExhibitC from "./components/sections/exhibit-c";
import ExhibitD from "./components/sections/exhibit-d";
import ExhibitE from "./components/sections/exhibit-e";
import ExhibitF from "./components/sections/exhibit-f";
import Hero from "./components/sections/hero";
import { SocialProof } from "./components/social-proof";

export default function Home() {
	return (
		<>
			<GridBackground />
			<Nav />
			<Hero />
			<Docket />
			<ExhibitA />
			<ExhibitB />
			<ExhibitC />
			<ExhibitD />
			<ExhibitE />
			<ExhibitF />
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
