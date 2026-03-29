import { resolve } from "node:path";
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
			{
				source: "/docs",
				destination: "https://github.com/usertools-ai/usertrust#readme",
				permanent: false,
			},
		];
	},
};

export default nextConfig;
