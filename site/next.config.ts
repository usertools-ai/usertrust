import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	outputFileTracingRoot: resolve(import.meta.dirname),
	images: {
		formats: ["image/avif", "image/webp"],
	},
	experimental: {
		// Tree-shake barrel imports so only used animations/components ship.
		optimizePackageImports: ["motion", "fumadocs-ui"],
	},
	async redirects() {
		return [
			{
				source: "/github",
				destination: "https://github.com/usertools-ai/usertrust",
				permanent: false,
			},
		];
	},
	/*
	 * `/r/<receiptId>` (verify-page spec D1/R35): the rendered HTML response
	 * itself carries `Cache-Control: no-store` — the SSR fetch's own
	 * `cache: "no-store"` option only governs the server-side data request,
	 * and a page a CDN/browser is free to cache is a cached green check by
	 * another road. This is a Next.js page (not a Route Handler), so this
	 * is the one place its OWN response headers can be set; the two JSON
	 * download routes under the same segment set `Cache-Control: no-store`
	 * directly on their own `Response`, so they are deliberately not
	 * matched here to avoid two competing header sources for one response.
	 *
	 * `X-Robots-Tag: noindex, nofollow` is the dark-ship half (plan §"Global
	 * Constraints": "unlinked, `noindex`, behind the resolver-live gate") —
	 * belt-and-suspenders alongside `page.tsx`'s `generateMetadata` robots
	 * meta tag, since the HTTP header is honored even by a crawler that
	 * never renders the HTML `<head>`.
	 */
	async headers() {
		return [
			{
				source: "/r/:receiptId",
				headers: [
					{ key: "Cache-Control", value: "no-store" },
					{ key: "X-Robots-Tag", value: "noindex, nofollow" },
				],
			},
		];
	},
};

const withMDX = createMDX();

export default withMDX(nextConfig);
