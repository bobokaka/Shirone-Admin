import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { TaxonomyKind } from "@shirone-admin/shared";
import { POSTS_DIR } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { parseFrontmatter, serializeFrontmatter } from "../lib/frontmatter.js";
import { POST_ORDER, listPosts } from "../adapters/storage.js";

const renameSchema = z.object({
	kind: z.enum(["category", "tag"]),
	from: z.string().min(1, "from 不能为空"),
	/** 目标名；空字符串 = 从所有文章中移除 */
	to: z.string(),
});

/**
 * 分类/标签批量重命名（to 已存在即合并），复用 serializeFrontmatter
 * 保证 published 等日期字段格式不变。
 */
export async function taxonomyRoutes(app: FastifyInstance): Promise<void> {
	app.post("/api/taxonomy/rename", async (req) => {
		const { kind, from, to } = renameSchema.parse(req.body);
		const posts = await listPosts();
		let changed = 0;
		for (const meta of posts) {
			const abs = path.resolve(POSTS_DIR, meta.path.replace(/\//g, path.sep));
			if (!abs.startsWith(POSTS_DIR + path.sep)) {
				throw new ApiError(400, `非法路径：${meta.path}`);
			}
			const raw = await fs.readFile(abs, "utf8").catch(() => null);
			if (raw === null) continue;
			const parsed = parseFrontmatter(raw);
			const data = parsed.data;
			let touched = false;

			if (kind === "category") {
				if (String(data.category ?? "") === from) {
					touched = true;
					if (to) data.category = to;
					else delete data.category;
				}
			} else {
				const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
				const idx = tags.indexOf(from);
				if (idx >= 0) {
					touched = true;
					const next = [...tags];
					next.splice(idx, 1);
					if (to && !next.includes(to)) next.splice(idx, 0, to);
					data.tags = next;
				}
			}

			if (touched) {
				await fs.writeFile(abs, serializeFrontmatter(data, POST_ORDER, parsed.body));
				changed += 1;
			}
		}
		return { changed, kind: kind as TaxonomyKind, from, to };
	});
}
