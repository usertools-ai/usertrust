/**
 * The resource footer, cloned from usertrust.ai's own: the same four links and
 * the same part-of line (same structure and classes; the CSS is cloned in
 * `brand.css`). Every URL here was fetched and
 * answers 200: a footer link that 404s is worse than no link, so a link that
 * does not exist yet (a privacy page) is not listed.
 *
 * Absolute URLs on purpose: this page is served from a different host than the
 * docs it points at, so a relative link would resolve to the wrong place.
 */
export const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
	{ label: "docs", href: "https://usertrust.ai/docs/" },
	{ label: "github", href: "https://github.com/usertools-ai/usertrust" },
	{ label: "npm", href: "https://www.npmjs.com/package/usertrust" },
	{ label: "licence", href: "https://github.com/usertools-ai/usertrust/blob/master/LICENSE" },
];

export default function SiteFooter() {
	return (
		<footer className="site" data-testid="site-footer">
			<div className="wrap">
				<nav className="flinks" aria-label="footer">
					{FOOTER_LINKS.map((link) => (
						<a key={link.href} href={link.href}>
							{link.label}
						</a>
					))}
				</nav>
				<p className="part">
					usertrust &middot; part of <a href="https://usertools.ai">usertools.ai</a>
				</p>
			</div>
		</footer>
	);
}
