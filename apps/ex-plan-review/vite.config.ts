import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteSingleFile } from "vite-plugin-singlefile";

export default defineConfig({
	plugins: [react(), tailwindcss(), viteSingleFile()],
	resolve: {
		dedupe: ["react", "react-dom"],
		alias: {
			"@plannotator/core": path.resolve(__dirname, "../../packages/core"),
			"@plannotator/shared": path.resolve(__dirname, "../../packages/shared"),
			"@plannotator/ui": path.resolve(__dirname, "../../packages/ui"),
		},
	},
	build: {
		target: "esnext",
		assetsInlineLimit: 100_000_000,
		chunkSizeWarningLimit: 100_000_000,
		cssCodeSplit: false,
		rollupOptions: { output: { inlineDynamicImports: true } },
	},
});
