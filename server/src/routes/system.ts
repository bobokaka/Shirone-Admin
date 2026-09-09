import type { FastifyInstance } from "fastify";
import type { SystemStatus } from "@shirone-admin/shared";
import { CONTENT_DIR, THEME_DIR, contentConnected, themeConnected, themeDepsInstalled } from "../config.js";
import { gitStatus } from "../adapters/git.js";
import { previewStart, previewStatus, previewStop } from "../services/preview.js";

export async function systemRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/status", async (): Promise<SystemStatus> => {
		const git = await gitStatus().catch(() => null);
		return {
			contentDir: CONTENT_DIR,
			themeDir: THEME_DIR,
			contentConnected: contentConnected(),
			themeConnected: themeConnected(),
			themeDepsInstalled: themeDepsInstalled(),
			git,
		};
	});

	app.post("/api/preview/start", async () => previewStart());
	app.post("/api/preview/stop", async () => previewStop());
	app.get("/api/preview/status", async () => previewStatus());
}
