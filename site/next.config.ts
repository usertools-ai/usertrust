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
};

const withMDX = createMDX();

export default withMDX(nextConfig);
