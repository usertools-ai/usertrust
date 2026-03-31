import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
	resolve: {
		alias: {
			// Resolve workspace packages to source for tests (dist/ may not exist in CI)
			usertrust: resolve(__dirname, "packages/core/src/index.ts"),
			"usertrust/headless": resolve(__dirname, "packages/core/src/headless.ts"),
		},
	},
	test: {
		globals: false,
		include: ["packages/*/tests/**/*.test.ts"],
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			exclude: ["packages/*/src/cli/**"],
			thresholds: {
				lines: 92,
				branches: 84,
				functions: 90,
			},
		},
	},
});
