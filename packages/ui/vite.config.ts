import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { faviconPlugin } from "./favicon-plugin.js";

export default defineConfig({
	root: "src/app",
	resolve: {
		alias: {
			// `usertrust/receipt` is pure (no Node imports), so the bundle takes core's source directly. Its package export
			// points at core's `dist/`, which nothing builds before a ui build, a ui test or `prepublishOnly`.
			"usertrust/receipt": join(import.meta.dirname, "..", "core", "src", "receipt", "format.ts"),
		},
	},
	plugins: [
		react(),
		tailwindcss(),
		faviconPlugin(join(import.meta.dirname, "brand", "usertrust-mark.svg")),
	],
	build: { outDir: "../../dist/app", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:4180" } },
});
