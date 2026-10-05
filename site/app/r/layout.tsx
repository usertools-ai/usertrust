import type { ReactNode } from "react";
import LatticeField from "./components/lattice-field";
import SiteFooter from "./components/site-footer";
import "./brand.css";

/**
 * The `/r/*` shell: the usertrust.ai ground and mark around whatever state the
 * page resolves. Presentation only — the page below decides every verdict.
 *
 * The brand mark markup is the one usertrust.ai's nav uses; its CSS is cloned
 * verbatim in `brand.css`.
 */
export default function ReceiptRouteLayout({ children }: { children: ReactNode }) {
	return (
		<div className="ut-r">
			<LatticeField />
			<nav className="ut-r-nav" aria-label="usertrust">
				<a className="brand" href="https://usertrust.ai/" aria-label="usertrust home">
					<span className="mark" aria-hidden="true">
						ut
					</span>
					<span className="word">usertrust</span>
				</a>
				<span className="where">receipt</span>
			</nav>
			<div className="ut-r-main mx-auto max-w-[680px] px-4 pb-6 sm:px-6">{children}</div>
			<SiteFooter />
		</div>
	);
}
