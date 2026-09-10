import type { FastifyInstance } from "fastify";
import fs from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ProjectMappingSaveResult, ProjectMappingStatus, SystemStatus } from "@shirone-admin/shared";
import {
	ADMIN_DIR,
	ASSETS_DIR,
	CONTENT_DIR,
	ENV_FILE,
	PUBLIC_DIR,
	THEME_DIR,
	applyProjectPaths,
	contentConnected,
	defaultProjectPaths,
	themeConnected,
	themeDepsInstalled,
} from "../config.js";
import { ApiError } from "../lib/errors.js";
import { updateEnvFile } from "../lib/envFile.js";
import { gitStatus } from "../adapters/git.js";
import { previewStart, previewStatus, previewStop } from "../services/preview.js";
import { pickFolder } from "../services/folderPicker.js";
import { detectProjectDirs, hasFullSignature } from "../services/dirDetect.js";
import { aiReady, loadAiSettings } from "../services/aiSettings.js";

async function mappingStatus(): Promise<ProjectMappingStatus> {
	const defaults = defaultProjectPaths();
	const ai = await loadAiSettings();
	return {
		contentDir: CONTENT_DIR,
		themeDir: THEME_DIR,
		defaultContentDir: defaults.contentDir,
		defaultThemeDir: defaults.themeDir,
		contentCustom: CONTENT_DIR !== defaults.contentDir,
		themeCustom: THEME_DIR !== defaults.themeDir,
		contentConnected: contentConnected(),
		themeConnected: themeConnected(),
		themeDepsInstalled: themeDepsInstalled(),
		aiEnabled: ai.enable && aiReady(ai),
	};
}

const mappingPutSchema = z.object({
	contentDir: z.string().trim().max(300).nullable().optional(),
	themeDir: z.string().trim().max(300).nullable().optional(),
});

/** 软校验（收集警示不阻断）+ 硬校验（绝对路径，直接抛 400） */
function checkMappingDir(label: string, dir: string, kind: "content" | "theme"): string[] {
	if (!path.isAbsolute(dir)) throw new ApiError(400, `${label}须为绝对路径：${dir}`);
	const warnings: string[] = [];
	const resolved = path.resolve(dir);
	if (!existsSync(resolved)) {
		warnings.push(`${label}目录不存在：${resolved}`);
		return warnings;
	}
	if (!statSync(resolved).isDirectory()) {
		warnings.push(`${label}路径是文件而非目录：${resolved}`);
		return warnings;
	}
	if (!hasFullSignature(resolved, kind)) {
		warnings.push(kind === "content"
			? `${label}缺少内容仓特征（content/posts 与 config/site.yaml）`
			: `${label}缺少主题仓特征（astro.config.* 与 scripts/content/sync.mjs）`);
	}
	const adminKey = ADMIN_DIR.toLowerCase() + path.sep;
	if (resolved.toLowerCase() === ADMIN_DIR.toLowerCase() || (resolved.toLowerCase() + path.sep).startsWith(adminKey)) {
		warnings.push(`${label}目录位于 Admin 仓内部，请确认`);
	}
	return warnings;
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
	app.get("/", async () => ({ name: "shirone-admin-api", ok: true, api: "/api" }));

	// 端点索引：新增路由时同步此清单
	app.get("/api", async () => ({
		name: "shirone-admin-api",
		system: [
			"GET /api/status",
			"GET /api/system/mapping",
			"PUT /api/system/mapping",
			"POST /api/system/pick-folder",
			"POST /api/system/detect-dirs",
			"POST /api/preview/start",
			"POST /api/preview/stop",
			"GET /api/preview/status",
		],
		posts: [
			"GET /api/posts",
			"GET /api/posts/detail",
			"POST /api/posts",
			"PUT /api/posts",
			"DELETE /api/posts",
			"POST /api/slug",
		],
		moments: [
			"GET /api/moments",
			"GET /api/moments/detail",
			"POST /api/moments",
			"PUT /api/moments",
			"DELETE /api/moments",
		],
		media: [
			"GET /api/media/site-images",
			"POST /api/media/post-image",
			"POST /api/media/moment-image",
			"POST /api/media/site-image",
			"POST /api/media/site-image-import",
			"POST /api/media/data-cover",
			"POST /api/media/data-cover-import",
			"POST /api/media/music-audio",
			"POST /api/media/music-download",
		],
		publish: ["GET /api/publish/preview", "POST /api/publish/probe", "POST /api/publish", "POST /api/validate"],
		settings: ["GET /api/settings/:domain", "PUT /api/settings/:domain"],
		data: ["GET /api/data/:kind", "PUT /api/data/:kind"],
		taxonomy: ["POST /api/taxonomy/rename"],
		ai: [
			"GET /api/ai/settings",
			"PUT /api/ai/settings",
			"POST /api/ai/test",
			"POST /api/ai/chat",
			"POST /api/ai/chat-stream",
			"POST /api/ai/edit",
			"POST /api/ai/edit-stream",
			"POST /api/ai/music-search",
			"POST /api/ai/wallpaper-search",
			"POST /api/ai/commit-message",
			"POST /api/ai/timeline-draft",
		],
		bangumi: ["GET /api/bangumi/search", "GET /api/bangumi/subject", "POST /api/bangumi/cover-import"],
		import: [
			"POST /api/import/jianshu/archive",
			"GET /api/import/jianshu/preview",
			"POST /api/import/jianshu/run",
			"GET /api/import/jianshu/job",
			"DELETE /api/import/jianshu/session",
			"POST /api/import/jianshu/paste-preview",
			"POST /api/import/jianshu/paste-run",
			"POST /api/import/jianshu/suggest-meta",
		],
	}));

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

	app.get("/api/system/mapping", async (): Promise<ProjectMappingStatus> => mappingStatus());

	app.put("/api/system/mapping", async (req): Promise<ProjectMappingSaveResult> => {
		const body = mappingPutSchema.parse(req.body ?? {});
		// undefined = 不动该仓；null / 空串 = 恢复默认
		const contentInput = body.contentDir === undefined ? undefined : body.contentDir || null;
		const themeInput = body.themeDir === undefined ? undefined : body.themeDir || null;
		if (contentInput === undefined && themeInput === undefined) {
			throw new ApiError(400, "未提供任何映射字段");
		}

		const defaults = defaultProjectPaths();
		const nextContent = contentInput ? path.resolve(contentInput) : contentInput === null ? defaults.contentDir : CONTENT_DIR;
		const nextTheme = themeInput ? path.resolve(themeInput) : themeInput === null ? defaults.themeDir : THEME_DIR;
		if (nextContent.toLowerCase() === nextTheme.toLowerCase()) {
			throw new ApiError(400, "内容仓与主题仓不能是同一目录");
		}

		const warnings: string[] = [];
		if (contentInput) warnings.push(...checkMappingDir("内容仓", contentInput, "content"));
		if (themeInput) warnings.push(...checkMappingDir("主题仓", themeInput, "theme"));

		// 预览进程持有旧 cwd，先清场（幂等）；失败不阻塞映射保存
		await previewStop().catch(() => undefined);
		applyProjectPaths({ contentDir: contentInput, themeDir: themeInput });
		await fs.mkdir(ASSETS_DIR, { recursive: true });
		await fs.mkdir(PUBLIC_DIR, { recursive: true });
		const updates: Record<string, string | null> = {};
		if (contentInput !== undefined) updates.CONTENT_DIR = contentInput;
		if (themeInput !== undefined) updates.THEME_DIR = themeInput;
		await updateEnvFile(ENV_FILE, updates);

		return { ...(await mappingStatus()), warnings };
	});

	const pickSchema = z.object({ title: z.string().trim().max(60).optional() });
	app.post("/api/system/pick-folder", async (req) => {
		const { title } = pickSchema.parse(req.body ?? {});
		if (process.platform !== "win32") throw new ApiError(400, "系统对话框仅支持 Windows，请手动输入路径");
		return pickFolder(title ?? "选择目录");
	});

	app.post("/api/system/detect-dirs", async () => detectProjectDirs());

	app.post("/api/preview/start", async () => previewStart());
	app.post("/api/preview/stop", async () => previewStop());
	app.get("/api/preview/status", async () => previewStatus());
}
