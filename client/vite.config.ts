import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
	plugins: [vue()],
	server: {
		port: 5173,
		strictPort: true,
		proxy: {
			"/api": "http://127.0.0.1:5175",
			"/content-assets": "http://127.0.0.1:5175",
			"/content-public": "http://127.0.0.1:5175",
			"/content-posts": "http://127.0.0.1:5175",
		},
	},
});
