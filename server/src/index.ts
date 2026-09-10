import fs from "node:fs/promises";
import { execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { ASSETS_DIR, PORT, POSTS_DIR, PUBLIC_DIR, THEME_ASSETS_DIR, THEME_PUBLIC_DIR } from "./config.js";
import { ApiError } from "./lib/errors.js";
import { postRoutes } from "./routes/posts.js";
import { momentRoutes } from "./routes/moments.js";
import { mediaRoutes } from "./routes/media.js";
import { publishRoutes } from "./routes/publish.js";
import { settingsRoutes } from "./routes/settings.js";
import { dataRoutes } from "./routes/data.js";
import { taxonomyRoutes } from "./routes/taxonomy.js";
import { systemRoutes } from "./routes/system.js";
import { aiRoutes } from "./routes/ai.js";
import { bangumiRoutes } from "./routes/bangumi.js";
import { importRoutes } from "./routes/import.js";

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

await app.register(cors, { origin: true });
await app.register(multipart, {
	limits: { fileSize: 30 * 1024 * 1024, files: 1 },
});

app.setErrorHandler((error, _req, reply) => {
	const err = error as Error & { code?: string };
	if (error instanceof ApiError) {
		reply.code(error.status).send({ message: error.message });
		return;
	}
	if (error instanceof z.ZodError) {
		reply.code(400).send({
			message: error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("；"),
		});
		return;
	}
	if (err.code === "FST_REQ_FILE_TOO_LARGE") {
		reply.code(413).send({ message: "文件超过 30MB 限制" });
		return;
	}
	if (err.code === "ENOENT") {
		reply.code(404).send({ message: "文件不存在" });
		return;
	}
	console.error("[server]", error);
	reply.code(500).send({ message: err.message });
});

app.setNotFoundHandler((req, reply) => {
	reply.code(404).send({ message: `not found: ${req.url}` });
});

await app.register(systemRoutes);
await app.register(postRoutes);
await app.register(momentRoutes);
await app.register(mediaRoutes);
await app.register(publishRoutes);
await app.register(settingsRoutes);
await app.register(dataRoutes);
await app.register(taxonomyRoutes);
await app.register(aiRoutes);
await app.register(bangumiRoutes);
await app.register(importRoutes);

// 内容仓静态预览：assets/ 与 public/（上传前目录可能不存在，先确保创建）
await fs.mkdir(ASSETS_DIR, { recursive: true });
await fs.mkdir(PUBLIC_DIR, { recursive: true });
// 只取 sendFile 能力，路由自己挂：内容仓（覆盖层）优先，未命中回退主题仓（默认层），
// 与 content:sync 物化语义一致——头像、favicon 等引用主题自带资源时文件并不在内容仓。
// 注册时的 root 只是默认值（serve:false 下从不参与），实际根目录由下方路由显式传入，
// 勿依赖此处的启动期快照。
await app.register(fastifyStatic, { root: ASSETS_DIR, serve: false });

function resolveWithin(root: string, rel: string): string | null {
	const full = path.normalize(path.join(root, rel));
	return full.startsWith(root + path.sep) ? full : null;
}

// roots 为请求时求值的闭包：项目映射热切换后预览跟随新目录
const previewMounts: { prefix: string; roots: () => string[] }[] = [
	{ prefix: "/content-assets", roots: () => [ASSETS_DIR, THEME_ASSETS_DIR] },
	{ prefix: "/content-public", roots: () => [PUBLIC_DIR, THEME_PUBLIC_DIR] },
	// 文章同目录图片（导入向导转换步预览 ./images/… 用）
	{ prefix: "/content-posts", roots: () => [POSTS_DIR] },
];

for (const { prefix, roots } of previewMounts) {
	app.get(`${prefix}/*`, async (req, reply) => {
		const rel = (req.params as Record<string, string>)["*"] ?? "";
		for (const root of roots()) {
			const full = resolveWithin(root, rel);
			if (full && existsSync(full) && statSync(full).isFile()) {
				return reply.sendFile(rel, root);
			}
		}
		throw new ApiError(404, "文件不存在");
	});
}

/** 找出占用端口的进程并连树清掉（5175 是 admin 专用端口，占用者几乎必是残留实例） */
function killPortListeners(port: number): void {
	try {
		const out = execSync(`netstat -ano | findstr LISTENING | findstr ":${port} "`).toString();
		const pids = [
			...new Set(
				out
					.split(/\r?\n/)
					.map((line) => line.trim().split(/\s+/).pop())
					.filter((pid): pid is string => !!pid && /^\d+$/.test(pid)),
			),
		];
		for (const pid of pids) {
			try {
				execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
			} catch {
				// 单个清理失败不阻塞启动
			}
		}
	} catch {
		// findstr 无匹配时非零退出，视为端口已空闲
	}
}

function listen(retryOnBusy: boolean): void {
	app
		.listen({ port: PORT, host: "127.0.0.1" })
		.then(() => {
			console.log(`[shirone-admin] API 就绪：http://127.0.0.1:${PORT}`);
		})
		.catch((err: { code?: string; message: string }) => {
			if (err.code === "EADDRINUSE" && retryOnBusy) {
				console.log(`[shirone-admin] 端口 ${PORT} 被残留实例占用，正在清理后重试…`);
				killPortListeners(PORT);
				setTimeout(() => listen(false), 800);
				return;
			}
			console.error(`[shirone-admin] 启动失败：${err.message}`);
			process.exit(1);
		});
}

listen(true);
