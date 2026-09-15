import fs from "node:fs/promises";
import path from "node:path";
import type { LocalFolderList } from "@shirone-admin/shared";
import * as storage from "../adapters/storage.js";
import { ApiError } from "../lib/errors.js";

/**
 * 本地文件夹直读：原生对话框选目录后由 server 读写该目录。
 * 浏览器 file input 拿不到「md 所在目录的兄弟文件」，服务端同机直读是最可靠的方式。
 */

const IMG_EXT = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const MD_EXT = /\.(md|markdown)$/i;
const SKIP_DIRS = new Set(["node_modules", "$RECYCLE.BIN", "System Volume Information"]);
const MAX_ENTRIES = 3000;
const MAX_WALK_DEPTH = 8;
const MAX_READ_BYTES = 200 * 1024 * 1024;

const MIME: Record<string, string> = {
	".webp": "image/webp",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".avif": "image/avif",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".mov": "video/quicktime",
	".m4v": "video/x-m4v",
	".ogv": "video/ogg",
	".mp3": "audio/mpeg",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".m4a": "audio/mp4",
	".flac": "audio/flac",
	".aac": "audio/aac",
	".md": "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
};

function extOf(name: string): string {
	return path.extname(name).toLowerCase();
}

function isMediaName(name: string): boolean {
	const ext = extOf(name);
	return IMG_EXT.has(ext) || VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext);
}

/** 相对路径归一（/ 分隔、拒 ../ 与绝对路径），不合法抛 400 */
function normalizeRel(rel: string): string {
	const norm = rel.trim().replace(/\\/g, "/");
	if (norm === "" || /^([a-zA-Z]:)?\//.test(norm)) throw new ApiError(400, "非法的相对路径");
	const segs = norm.split("/");
	if (segs.some((s) => s === ".." || s === "")) throw new ApiError(400, "非法的相对路径");
	return segs.join("/");
}

async function requireDir(dir: string): Promise<string> {
	if (!path.isAbsolute(dir)) throw new ApiError(400, `须为绝对路径：${dir}`);
	const resolved = path.resolve(dir);
	const st = await fs.stat(resolved).catch(() => null);
	if (!st || !st.isDirectory()) throw new ApiError(400, `目录不存在：${resolved}`);
	return resolved;
}

/** 目录内文件须真正落在该目录下（防符号链接与大小写差异绕过） */
async function resolveWithin(root: string, rel: string): Promise<string> {
	const relPath = normalizeRel(rel);
	const abs = path.resolve(path.join(root, relPath));
	const lower = abs.toLowerCase();
	const rootLower = root.toLowerCase();
	if (lower !== rootLower && !lower.startsWith(rootLower + path.sep)) {
		throw new ApiError(400, "路径越界");
	}
	const st = await fs.stat(abs).catch(() => null);
	if (!st || !st.isFile()) throw new ApiError(404, `文件不存在：${relPath}`);
	return abs;
}

async function walk(dir: string, base: string, depth: number, out: LocalFolderList): Promise<void> {
	if (out.mds.length + out.medias.length > MAX_ENTRIES) return;
	if (depth > MAX_WALK_DEPTH) return;
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	for (const e of entries) {
		if (e.name.startsWith(".")) continue; // 隐藏文件与目录（.git、.obsidian 等）跳过
		if (e.isDirectory()) {
			if (SKIP_DIRS.has(e.name)) continue;
			await walk(path.join(dir, e.name), base, depth + 1, out);
			continue;
		}
		const relPath = path.relative(base, path.join(dir, e.name)).replace(/\\/g, "/");
		if (MD_EXT.test(e.name)) out.mds.push({ name: e.name, relPath });
		else if (isMediaName(e.name)) out.medias.push({ name: e.name, relPath });
	}
}

export async function listLocalFolder(dir: string): Promise<LocalFolderList> {
	const resolved = await requireDir(dir);
	const out: LocalFolderList = { dir: resolved, mds: [], medias: [] };
	await walk(resolved, resolved, 0, out);
	const zh = (a: string, b: string) => a.localeCompare(b, "zh-Hans-CN");
	out.mds.sort((a, b) => zh(a.relPath, b.relPath));
	out.medias.sort((a, b) => zh(a.relPath, b.relPath));
	return out;
}

export async function readLocalFile(
	dir: string,
	rel: string,
): Promise<{ buf: Buffer; type: string }> {
	const root = await requireDir(dir);
	const abs = await resolveWithin(root, rel);
	const ext = extOf(abs);
	const type = MIME[ext];
	if (!type) throw new ApiError(400, `不支持的文件类型：${ext || "(无扩展名)"}`);
	const st = await fs.stat(abs);
	if (st.size > MAX_READ_BYTES) {
		throw new ApiError(400, `文件过大（${Math.round(st.size / 1048576)}MB，上限 200MB）`);
	}
	return { buf: await fs.readFile(abs), type };
}

/** 转换入库：服务端直读本地文件写进仓库——图片 → 文章配图目录，视频/音频 → public 站根 */
export async function collectLocalFile(dir: string, rel: string, slug: string) {
	const { buf } = await readLocalFile(dir, rel);
	const name = normalizeRel(rel).split("/").pop() ?? "media";
	return IMG_EXT.has(extOf(name))
		? storage.uploadPostImage(slug, name, buf)
		: storage.uploadPostAsset(slug, name, buf);
}
