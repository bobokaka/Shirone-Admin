import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { uploadDataCover } from "../adapters/storage.js";
import { ApiError } from "../lib/errors.js";
import { fetchBangumiSubject, searchBangumi } from "../services/bangumi.js";
import { assertPublicHttpUrl, downloadRemoteImage } from "../services/remoteMedia.js";

/** 封面导入只信 Bangumi 自家图床（lain.bgm.tv），杜绝把任意外链变成服务端下载器 */
const BANGUMI_COVER_HOSTS = new Set(["lain.bgm.tv", "api.bgm.tv", "bgm.tv", "bangumi.tv", "ei.hdslb.com"]);

export async function bangumiRoutes(app: FastifyInstance): Promise<void> {
	// 番剧条目搜索（type 2 = 动画）
	app.get("/api/bangumi/search", async (req) => {
		const q = z.object({ keyword: z.string().trim().min(1).max(100) }).parse(req.query);
		return { candidates: await searchBangumi(q.keyword) };
	});

	// 条目详情：infobox/Tags 补全制作公司、放送档期、类型标签
	app.get("/api/bangumi/subject", async (req) => {
		const q = z.object({ id: z.coerce.number().int().positive() }).parse(req.query);
		return fetchBangumiSubject(q.id);
	});

	/** 封面导入：Bangumi 图床直链 → 下载 → 落内容仓 public/assets/anime/（currentPath 命中时原位替换） */
	app.post("/api/bangumi/cover-import", async (req) => {
		const b = z
			.object({
				url: z.string().trim().min(1).max(2000),
				title: z.string().trim().min(1).max(200),
				currentPath: z.string().optional(),
			})
			.parse(req.body);
		let host: string;
		try {
			host = assertPublicHttpUrl(b.url).hostname.toLowerCase();
		} catch {
			throw new ApiError(400, "封面地址不合法");
		}
		if (!BANGUMI_COVER_HOSTS.has(host)) {
			throw new ApiError(400, `只接受 Bangumi 图床地址（lain.bgm.tv），收到：${host}`);
		}
		const { buf, fileName } = await downloadRemoteImage(b.url);
		// 以条目标题命名（storage 层 asciiName 清洗），便于在目录里认出是哪部番
		const ext = fileName.match(/\.[a-z0-9]+$/i)?.[0] ?? ".jpg";
		return uploadDataCover("anime", b.currentPath, `${b.title}${ext}`, buf);
	});
}
