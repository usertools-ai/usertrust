import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { faviconPlugin } from "./favicon-plugin.js";

export default defineConfig({
	root: "src/app",
	plugins: [
		react(),
		tailwindcss(),
		faviconPlugin(join(import.meta.dirname, "brand", "usertrust-mark.svg")),
	],
	build: { outDir: "../../dist/app", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:4180" } },
});
