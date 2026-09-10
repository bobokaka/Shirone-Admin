import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Admin 仓根目录（server/src 的上两级，即 Shirone-Admin） */
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** 工作区根（blogs_ws，即 Shirone-Admin 的上一级） */
const workspaceRoot = path.resolve(serverRoot, "..");
/** 目录探测扫描的锚点之一（与默认项目路径同一层级语义） */
export const WORKSPACE_ROOT = workspaceRoot;

try {
	process.loadEnvFile(path.join(serverRoot, ".env"));
} catch {
	// .env 不存在时按相对位置自动解析
}

/** 不用通用名 PORT：部分机器全局环境已设 PORT，会劫持默认值 */
export const PORT = Number(process.env.ADMIN_PORT ?? 5175);

/** .env 路径（项目映射持久化目标，Admin 仓自身文件，已 gitignore） */
export const ENV_FILE = path.join(serverRoot, ".env");

/** 默认项目路径（workspace 相对解析；「恢复默认」与初始解析共用） */
export function defaultProjectPaths(): { contentDir: string; themeDir: string } {
	return {
		contentDir: path.join(workspaceRoot, "Shirone-Content"),
		themeDir: path.join(workspaceRoot, "Shirone"),
	};
}

// 以下目录用 let 而非 const：ESM live binding 让「函数体内引用」的导入方
// 在 applyProjectPaths() 热切换后自动读到新值。新增代码禁止在模块顶层
// 对这些导出做快照（const x = CONTENT_DIR、顶层 join、模块级句柄/缓存），
// 必须在函数调用时引用导入名。
export let CONTENT_DIR = path.resolve(process.env.CONTENT_DIR ?? defaultProjectPaths().contentDir);
export let THEME_DIR = path.resolve(process.env.THEME_DIR ?? defaultProjectPaths().themeDir);
/** Admin 工具自身所在仓（时间线起草扫描其提交历史，只读） */
export const ADMIN_DIR = serverRoot;

export let POSTS_DIR: string;
export let MOMENTS_DIR: string;
export let MOMENT_IMAGES_DIR: string;

/** Admin 工具自身的数据目录（AI 设置等本地配置；已 gitignore，绝不写入内容仓） */
export const ADMIN_DATA_DIR = path.join(serverRoot, "data");

export let CONFIG_DIR: string;
export let ASSETS_DIR: string;
export let PUBLIC_DIR: string;
export let DATA_DIR: string;

/** 主题仓对应目录：内容仓未覆盖的媒体（默认头像、默认 favicon 等）在此层命中 */
export let THEME_ASSETS_DIR: string;
export let THEME_PUBLIC_DIR: string;
export let THEME_FAVICON_TS: string;

export let THEME_SYNC_SCRIPT: string;

function recomputeDerived(): void {
	POSTS_DIR = path.join(CONTENT_DIR, "content", "posts");
	MOMENTS_DIR = path.join(CONTENT_DIR, "content", "moments");
	MOMENT_IMAGES_DIR = path.join(CONTENT_DIR, "public", "images", "moments");
	CONFIG_DIR = path.join(CONTENT_DIR, "config");
	ASSETS_DIR = path.join(CONTENT_DIR, "assets");
	PUBLIC_DIR = path.join(CONTENT_DIR, "public");
	DATA_DIR = path.join(CONTENT_DIR, "data");
	THEME_ASSETS_DIR = path.join(THEME_DIR, "src", "assets");
	THEME_PUBLIC_DIR = path.join(THEME_DIR, "public");
	THEME_FAVICON_TS = path.join(THEME_DIR, "src", "constants", "icon.ts");
	THEME_SYNC_SCRIPT = path.join(THEME_DIR, "scripts", "content", "sync.mjs");
}

recomputeDerived();

/**
 * 应用项目映射并重算派生目录（热生效，无需重启）。
 * contentDir/themeDir 传绝对路径 = 应用；传 null 或空串 = 恢复默认；
 * 字段缺省（undefined）= 不动。同步写 process.env，保证子进程注入的
 * 环境与「下次重启 loadEnvFile(.env)」读到相同值。
 */
export function applyProjectPaths(input: {
	contentDir?: string | null;
	themeDir?: string | null;
}): void {
	const defaults = defaultProjectPaths();
	if (input.contentDir !== undefined) {
		const custom = input.contentDir?.trim() ?? "";
		CONTENT_DIR = custom ? path.resolve(custom) : defaults.contentDir;
		if (custom) process.env.CONTENT_DIR = CONTENT_DIR;
		else delete process.env.CONTENT_DIR;
	}
	if (input.themeDir !== undefined) {
		const custom = input.themeDir?.trim() ?? "";
		THEME_DIR = custom ? path.resolve(custom) : defaults.themeDir;
		if (custom) process.env.THEME_DIR = THEME_DIR;
		else delete process.env.THEME_DIR;
	}
	recomputeDerived();
}

export const contentConnected = () => existsSync(path.join(CONTENT_DIR, "content"));
export const themeConnected = () => existsSync(THEME_SYNC_SCRIPT);
export const themeDepsInstalled = () => existsSync(path.join(THEME_DIR, "node_modules"));
