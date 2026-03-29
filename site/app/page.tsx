import { BYOK } from "./components/byok";
import { CodeExample } from "./components/code-example";
import { CTA } from "./components/cta";
import { Features } from "./components/features";
import { Footer } from "./components/footer";
import { Hero } from "./components/hero";
import { HowItWorks } from "./components/how-it-works";
import { Nav } from "./components/nav";

export default function Home() {
	return (
		<>
			<Nav />
			<Hero />
			<CodeExample />
			<Features />
			<HowItWorks />
			<BYOK />
			<CTA />
			<Footer />
		</>
	);
}
