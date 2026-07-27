import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: "src/app",
	plugins: [react(), tailwindcss()],
	build: { outDir: "../../dist/app", emptyOutDir: true },
	server: { proxy: { "/api": "http://127.0.0.1:4180" } },
});
