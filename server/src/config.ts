import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** server 包根目录（server/src 的上两级） */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 工作区根（blogs_ws，即 Shirone-Admin 的上一级） */
const workspaceRoot = path.resolve(serverRoot, "..");

try {
	process.loadEnvFile(path.join(serverRoot, ".env"));
} catch {
	// .env 不存在时按相对位置自动解析
}

/** 不用通用名 PORT：部分机器全局环境已设 PORT，会劫持默认值 */
export const PORT = Number(process.env.ADMIN_PORT ?? 5175);

export const CONTENT_DIR = path.resolve(
	process.env.CONTENT_DIR ?? path.join(workspaceRoot, "Shirone-Content"),
);
export const THEME_DIR = path.resolve(
	process.env.THEME_DIR ?? path.join(workspaceRoot, "Shirone"),
);
/** Admin 工具自身所在仓（时间线起草扫描其提交历史，只读） */
export const ADMIN_DIR = path.resolve(serverRoot, "..");

export const POSTS_DIR = path.join(CONTENT_DIR, "content", "posts");
export const MOMENTS_DIR = path.join(CONTENT_DIR, "content", "moments");
export const MOMENT_IMAGES_DIR = path.join(CONTENT_DIR, "public", "images", "moments");

/** Admin 工具自身的数据目录（AI 设置等本地配置；已 gitignore，绝不写入内容仓） */
export const ADMIN_DATA_DIR = path.join(serverRoot, "data");

export const CONFIG_DIR = path.join(CONTENT_DIR, "config");
export const ASSETS_DIR = path.join(CONTENT_DIR, "assets");
export const PUBLIC_DIR = path.join(CONTENT_DIR, "public");
export const DATA_DIR = path.join(CONTENT_DIR, "data");

/** 主题仓对应目录：内容仓未覆盖的媒体（默认头像、默认 favicon 等）在此层命中 */
export const THEME_ASSETS_DIR = path.join(THEME_DIR, "src", "assets");
export const THEME_PUBLIC_DIR = path.join(THEME_DIR, "public");
export const THEME_FAVICON_TS = path.join(THEME_DIR, "src", "constants", "icon.ts");

export const THEME_SYNC_SCRIPT = path.join(THEME_DIR, "scripts", "content", "sync.mjs");

export const contentConnected = () => existsSync(path.join(CONTENT_DIR, "content"));
export const themeConnected = () => existsSync(THEME_SYNC_SCRIPT);
export const themeDepsInstalled = () => existsSync(path.join(THEME_DIR, "node_modules"));
