import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as jianshu from "../services/jianshuImport.js";
import { ApiError } from "../lib/errors.js";

/** 平台导入：简书官方导出包（rar/zip）→ 会话清单 → 预览/后台导入任务；另有单篇粘贴（无会话） */
const optionsSchema = z.object({
	published: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "发布日期须为 YYYY-MM-DD"),
	categoryFromNotebook: z.boolean(),
	category: z.string().trim().max(40).optional(),
	tags: z.array(z.string().trim().min(1).max(30)).max(12),
	localizeImages: z.boolean(),
	draft: z.boolean(),
});

/** 单篇粘贴载荷：富文本 / 纯文本 / 编辑器定稿 markdown 至少其一 */
const pastePayloadSchema = z
	.object({
		html: z.string().max(2 * 1024 * 1024).optional(),
		text: z.string().max(2 * 1024 * 1024).optional(),
		markdown: z.string().max(2 * 1024 * 1024).optional(),
	})
	.refine((v) => [v.html, v.text, v.markdown].some((x) => (x ?? "").trim() !== ""), { message: "粘贴内容为空" });

const pasteOptionsSchema = z.object({
	title: z.string().trim().min(1, "标题不能为空").max(100),
	published: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "发布日期须为 YYYY-MM-DD"),
	category: z.string().trim().max(40).optional(),
	tags: z.array(z.string().trim().min(1).max(30)).max(12),
	draft: z.boolean(),
});

function query(req: { query: unknown }, keys: string[]): Record<string, string> {
	const q = (req.query ?? {}) as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const key of keys) {
		const v = q[key];
		if (typeof v !== "string" || v === "") throw new ApiError(400, `缺少参数：${key}`);
		out[key] = v;
	}
	return out;
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
	// 上传导出包：解包 + 解析出按文集分组的文章清单
	app.post("/api/import/jianshu/archive", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少压缩包文件");
		const buf = await data.toBuffer();
		return jianshu.ingestArchive(data.filename, buf);
	});

	// 单篇转换预览（不落盘，图片保持远程链接）
	app.get("/api/import/jianshu/preview", async (req) => {
		const { sessionId, id } = query(req, ["sessionId", "id"]);
		return jianshu.previewArticle(sessionId, id);
	});

	// 启动后台导入任务，轮询 /job 取进度
	app.post("/api/import/jianshu/run", async (req) => {
		const b = z
			.object({
				sessionId: z.string().min(1),
				ids: z.array(z.string().min(1)).min(1).max(2000),
				options: optionsSchema,
			})
			.parse(req.body);
		return jianshu.startImportJob(b.sessionId, b.ids, b.options);
	});

	app.get("/api/import/jianshu/job", async (req) => {
		const { id } = query(req, ["id"]);
		return jianshu.getJob(id);
	});

	// 丢弃导入包（清会话；运行中任务阻止）
	app.delete("/api/import/jianshu/session", async (req) => {
		const { id } = query(req, ["id"]);
		return { ok: jianshu.deleteSession(id) };
	});

	// 单篇粘贴：转换预览（不落盘，图片保持远程链接）
	app.post("/api/import/jianshu/paste-preview", async (req) => {
		return jianshu.previewPaste(pastePayloadSchema.parse(req.body));
	});

	// 单篇粘贴：转换落仓（图片自动下载到文章目录，失败保留远程链接）
	app.post("/api/import/jianshu/paste-run", async (req) => {
		const b = pastePayloadSchema.and(z.object({ options: pasteOptionsSchema })).parse(req.body);
		return jianshu.importPaste(b, b.options);
	});

	// 单篇粘贴：AI 分析正文补充标题/摘要/分类/标签（未启用/失败回退正文摘要，aiUsed=false）
	app.post("/api/import/jianshu/suggest-meta", async (req) => {
		const b = z
			.object({
				title: z.string().trim().max(100).default(""), // 空标题=让 AI 一并拟定
				markdown: z.string().min(1).max(2 * 1024 * 1024),
			})
			.parse(req.body);
		return jianshu.suggestMeta(b);
	});
}
