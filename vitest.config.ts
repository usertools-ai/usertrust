import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
export default defineConfig({
	resolve: {
		alias: {
			// Resolve workspace packages to source for tests (dist/ may not exist in CI)
			usertrust: resolve(__dirname, "packages/core/src/index.ts"),
			"usertrust/headless": resolve(__dirname, "packages/core/src/headless.ts"),
			"usertrust-verify": resolve(__dirname, "packages/verify/src/index.ts"),
		},
	},
	test: {
		globals: false,
		include: ["packages/*/tests/**/*.test.ts"],
		passWithNoTests: true,
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			// CLI entrypoints are process-level scripts (parse argv, print,
			// process.exit) — excluded from unit coverage. verify's CLI is a
			// single file rather than a cli/ directory.
			exclude: [
				"packages/*/src/cli/**",
				"packages/verify/src/cli.ts",
				"packages/ui/src/app/**",
				// Bin entry — argv parsing + browser open; runtime-smoke-tested, not unit-testable
				"packages/ui/src/server/main.ts",
			],
			thresholds: {
				lines: 92,
				branches: 84,
				functions: 90,
			},
		},
	},
});
