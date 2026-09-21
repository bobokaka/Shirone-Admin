import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SavePostInput } from "@shirone-admin/shared";
import * as storage from "../adapters/storage.js";
import { sanitizeUserSlug, suggestSlug } from "../lib/slug.js";
import { applySavedOrder, loadPostOrder, savePostOrder } from "../services/postOrder.js";

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

const batchSchema = z.object({
	action: z.enum(["delete", "publish", "unpublish", "pin", "unpin"]),
	paths: z.array(z.string().min(1)).min(1, "未选择文章"),
});

const orderPutSchema = z.object({
	order: z.array(z.string().min(1)).max(10_000),
});

export async function postRoutes(app: FastifyInstance): Promise<void> {
	// 列表套用管理端本地的手动排序（server/data/post-order.json，不落内容仓）
	app.get("/api/posts", async () => {
		const [list, order] = await Promise.all([storage.listPosts(), loadPostOrder()]);
		return applySavedOrder(list, order);
	});

	app.put("/api/posts/order", async (req) => {
		const { order } = orderPutSchema.parse(req.body);
		await savePostOrder([...new Set(order)]);
		return { ok: true };
	});

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

	app.post("/api/posts/batch", async (req) => {
		const { action, paths } = batchSchema.parse(req.body);
		return storage.batchPosts(action, paths);
	});

	app.post("/api/slug", async (req) => {
		const input = z
			.object({ title: z.string().default(""), slug: z.string().optional() })
			.parse(req.body);
		return input.slug ? sanitizeUserSlug(input.slug) : suggestSlug(input.title);
	});
}
