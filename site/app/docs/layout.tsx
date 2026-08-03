import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Viewport } from "next";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

/*
 * Docs opts out of the root layout's `viewportFit: "cover"`.
 *
 * `cover` exists for the marketing page, whose hero is sized in `dvh` and needs
 * to paint under the iOS toolbar. Docs gains nothing from it and pays for it:
 * fumadocs' navbar is `position: fixed`, so the `body` safe-area padding in
 * globals.css cannot reach it, and fumadocs ships no safe-area handling of its
 * own — in landscape on a notched device its logo and search control would sit
 * under the cutout. Reverting to the default `auto` makes the browser inset the
 * layout viewport itself, which is the correct behaviour for a page with no
 * edge-to-edge art direction.
 *
 * `viewportFit` must be set to `"auto"` explicitly, not omitted: Next merges a
 * nested viewport export into the parent's field by field, so an absent field
 * inherits rather than clears. Verified in the emitted meta tag, which is the
 * only way to tell the two apart.
 */
export const viewport: Viewport = {
	width: "device-width",
	initialScale: 1,
	viewportFit: "auto",
	themeColor: "#0a0a1a",
	colorScheme: "dark",
};

export default function Layout({ children }: { children: ReactNode }) {
	return (
		<RootProvider
			theme={{
				defaultTheme: "dark",
				forcedTheme: "dark",
			}}
		>
			<DocsLayout tree={source.getPageTree()} {...baseOptions()}>
				{children}
			</DocsLayout>
		</RootProvider>
	);
}
