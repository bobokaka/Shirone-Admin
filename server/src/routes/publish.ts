import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { probeRemote } from "../adapters/git.js";
import { publish, publishPreview } from "../services/publish.js";
import { runDryValidation } from "../services/validate.js";

export async function publishRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/publish/preview", async () => publishPreview());

	/** 轻量比对远端（ls-remote，不拉取代码）：只回答「是否落后、落后多少」 */
	app.post("/api/publish/probe", async (req) => {
		const { repo } = z.object({ repo: z.enum(["content", "theme"]) }).parse(req.body ?? {});
		return probeRemote(repo);
	});

	app.post("/api/publish", async (req) => {
		const { contentMessage, themeMessage } = z
			.object({
				contentMessage: z.string().optional(),
				themeMessage: z.string().optional(),
			})
			.parse(req.body ?? {});
		return publish({ contentMessage, themeMessage });
	});

	app.post("/api/validate", async () => {
		const r = await runDryValidation();
		return { ok: r.ok, output: r.output };
	});
}
