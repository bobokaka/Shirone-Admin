import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SavePostInput } from "@shirone-admin/shared";
import * as storage from "../adapters/storage.js";
import { sanitizeUserSlug, suggestSlug } from "../lib/slug.js";

const createSchema = z.object({
	title: z.string().min(1, "标题不能为空"),
	slug: z.string().optional(),
});

const saveSchema = z.object({
	path: z.string().min(1),
	body: z.string().default(""),
	meta: z.record(z.unknown()).default({}),
	password: z.string().optional(),
	clearPassword: z.boolean().optional(),
});

const pathQuery = z.object({ path: z.string().min(1) });

export async function postRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/posts", async () => storage.listPosts());

	app.get("/api/posts/detail", async (req) => {
		return storage.readPost(pathQuery.parse(req.query).path);
	});

	app.post("/api/posts", async (req) => {
		return storage.createPost(createSchema.parse(req.body));
	});

	app.put("/api/posts", async (req) => {
		return storage.savePost(saveSchema.parse(req.body) as SavePostInput);
	});

	app.delete("/api/posts", async (req) => {
		await storage.deletePost(pathQuery.parse(req.query).path);
		return { ok: true };
	});

	app.post("/api/slug", async (req) => {
		const input = z
			.object({ title: z.string().default(""), slug: z.string().optional() })
			.parse(req.body);
		return input.slug ? sanitizeUserSlug(input.slug) : suggestSlug(input.title);
	});
}
