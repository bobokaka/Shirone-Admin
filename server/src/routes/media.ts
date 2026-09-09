import type { FastifyInstance } from "fastify";
import { z } from "zod";
import * as storage from "../adapters/storage.js";
import { ApiError } from "../lib/errors.js";
import { convertWebpIfNeeded, downloadRemoteAudio, downloadRemoteImage } from "../services/remoteMedia.js";

function fieldText(fields: unknown, name: string): string | undefined {
	const record = fields as Record<string, { value?: unknown } | undefined>;
	const f = record?.[name];
	if (!f || typeof f !== "object") return undefined;
	const v = f.value;
	return typeof v === "string" ? v : undefined;
}

export async function mediaRoutes(app: FastifyInstance): Promise<void> {
	// 文章配图：写入 content/posts/<slug>/images/
	app.post("/api/media/post-image", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少文件");
		const slug = fieldText(data.fields, "slug");
		if (!slug) throw new ApiError(400, "缺少 slug");
		const buf = await data.toBuffer();
		return storage.uploadPostImage(slug, data.filename, buf);
	});

	// 说说图片：写入 public/images/moments/<批次>/，可传 batchId 归入同批
	app.post("/api/media/moment-image", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少文件");
		const batch = fieldText(data.fields, "batchId");
		const buf = await data.toBuffer();
		return storage.uploadMomentImage(batch, data.filename, buf);
	});

	// 站点图片托管目录清单（页脚图片库等）
	app.get("/api/media/site-images", async (req) => {
		const { target } = z.object({ target: z.string().trim().min(1).max(40) }).parse(req.query);
		return storage.listSiteImages(target);
	});

	// 站点图片：target ∈ banner-desktop | banner-mobile | avatar | favicon；name 为可选固定文件名（favicon 槽位替换）；
	// currentSrc 为字段当前值，指向同目标托管目录时原位替换旧文件（头像）
	app.post("/api/media/site-image", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少文件");
		const target = fieldText(data.fields, "target");
		if (!target) throw new ApiError(400, "缺少 target");
		const fixedName = fieldText(data.fields, "name");
		const currentSrc = fieldText(data.fields, "currentSrc");
		const buf = await data.toBuffer();
		return storage.uploadSiteImage(target, data.filename, buf, fixedName || undefined, currentSrc || undefined);
	});

	// 站点图片：远程直链（横幅壁纸的在线地址等）→ 服务端代取下载 → 复用 uploadSiteImage 落目标托管目录
	app.post("/api/media/site-image-import", async (req) => {
		const b = z
			.object({
				target: z.string().trim().min(1).max(40),
				url: z.string().trim().min(1).max(2000),
				name: z.string().trim().max(200).optional(),
				currentSrc: z.string().trim().max(2000).optional(),
			})
			.parse(req.body);
		const { buf, fileName } = await downloadRemoteImage(b.url, b.name ?? "");
		const conv = await convertWebpIfNeeded(fileName, buf);
		return storage.uploadSiteImage(b.target, conv.fileName, conv.buf, b.name || undefined, b.currentSrc || undefined);
	});

	// 数据封面：kind 决定托管目录；path 指向同类型托管文件时原位覆盖（替换图片）
	app.post("/api/media/data-cover", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少文件");
		const kind = fieldText(data.fields, "kind");
		if (!kind) throw new ApiError(400, "缺少 kind");
		const currentPath = fieldText(data.fields, "path");
		const buf = await data.toBuffer();
		return storage.uploadDataCover(kind, currentPath, data.filename, buf);
	});

	// 歌单曲目音频：本地 multipart 上传，写 public/assets/music/url/
	app.post("/api/media/music-audio", async (req) => {
		const data = await req.file();
		if (!data) throw new ApiError(400, "缺少文件");
		const currentSrc = fieldText(data.fields, "currentSrc");
		const buf = await data.toBuffer();
		return storage.uploadMusicAudio(data.filename, buf, currentSrc || undefined);
	});

	// 歌单曲目音频：远程直链由 server 拉取后落盘（浏览器跨源拿不到的也能下）
	app.post("/api/media/music-download", async (req) => {
		const b = z
			.object({
				url: z.string().trim().min(1).max(2000),
				filename: z.string().trim().max(200).optional(),
				currentPath: z.string().optional(),
			})
			.parse(req.body);
		const { buf, fileName } = await downloadRemoteAudio(b.url, b.filename ?? "");
		return storage.uploadMusicAudio(fileName, buf, b.currentPath);
	});

	// 数据封面：远程直链（AI 检索出的封面 CDN 地址等）→ 下载 → 复用 uploadDataCover 落各类型目录
	app.post("/api/media/data-cover-import", async (req) => {
		const b = z
			.object({
				kind: z.enum(["anime", "projects", "devices", "friends", "music"]),
				url: z.string().trim().min(1).max(2000),
				title: z.string().trim().max(200).optional(),
				currentPath: z.string().optional(),
			})
			.parse(req.body);
		const { buf, fileName } = await downloadRemoteImage(b.url, b.title ?? "");
		return storage.uploadDataCover(b.kind, b.currentPath, fileName, buf);
	});
}
