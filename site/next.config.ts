import { resolve } from "node:path";
import { createMDX } from "fumadocs-mdx/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	outputFileTracingRoot: resolve(import.meta.dirname),
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
