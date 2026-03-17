import { defineConfig } from "vitest/config";
export default defineConfig({
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
				branches: 85,
				functions: 90,
			},
		},
	},
});
