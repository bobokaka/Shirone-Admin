import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MomentInput } from "@shirone-admin/shared";
import * as storage from "../adapters/storage.js";

const momentSchema = z.object({
	published: z.string().min(1),
	location: z.string().optional(),
	mood: z.string().optional(),
	tags: z.array(z.string()).optional(),
	images: z
		.array(z.object({ src: z.string(), alt: z.string().optional() }))
		.optional(),
	draft: z.boolean().optional(),
	pinned: z.boolean().optional(),
	body: z.string().default(""),
});

const updateSchema = momentSchema.extend({ path: z.string().min(1) });
const pathQuery = z.object({ path: z.string().min(1) });

export async function momentRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/moments", async () => storage.listMoments());

	app.get("/api/moments/detail", async (req) => {
		return storage.readMoment(pathQuery.parse(req.query).path);
	});

	app.post("/api/moments", async (req) => {
		return storage.createMoment(momentSchema.parse(req.body) as MomentInput);
	});

	app.put("/api/moments", async (req) => {
		const { path, ...input } = updateSchema.parse(req.body);
		return storage.updateMoment(path, input as MomentInput);
	});

	app.delete("/api/moments", async (req) => {
		await storage.deleteMoment(pathQuery.parse(req.query).path);
		return { ok: true };
	});
}
