import fs from "node:fs/promises";
import path from "node:path";
import type {
	CreatePostInput,
	MediaUploadResult,
	MomentFile,
	MomentInput,
	MomentMeta,
	PostFile,
	PostMeta,
	SavePostInput,
	SiteMediaResult,
} from "@shirone-admin/shared";
import { ASSETS_DIR, MOMENT_IMAGES_DIR, MOMENTS_DIR, POSTS_DIR, PUBLIC_DIR } from "../config.js";
import { ApiError } from "../lib/errors.js";
import { removeNavbarPostLinks, syncNavbarPostLinks } from "../lib/navbar-sync.js";
import { momentId, shanghaiMomentStamp, todayShanghai } from "../lib/datetime.js";
import { parseFrontmatter, serializeFrontmatter } from "../lib/frontmatter.js";
import { sanitizeUserSlug, suggestSlug } from "../lib/slug.js";

export const POST_ORDER = [
	"title",
	"published",
	"publishedAt",
	"updated",
	"updatedAt",
	"description",
	"image",
	"category",
	"tags",
	"pinned",
	"draft",
	"comment",
	"encrypted",
	"password",
	"passwordHint",
	"hideHomeContent",
	"alias",
	"permalink",
	"lang",
];
const MOMENT_ORDER = ["published", "pinned", "location", "mood", "tags", "images", "draft"];

const IMAGE_EXT = new Set([".webp", ".png", ".jpg", ".jpeg", ".gif", ".avif"]);

/* ---------- 基础工具 ---------- */

function within(base: string, rel: string): string {
	const abs = path.resolve(base, rel);
	if (abs !== base && !abs.startsWith(base + path.sep)) {
		throw new ApiError(400, `非法路径：${rel}`);
	}
	return abs;
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

function str(v: unknown, fallback = ""): string {
	return typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v);
}

function strOrUndef(v: unknown): string | undefined {
	const s = str(v).trim();
	return s === "" ? undefined : s;
}

function bool(v: unknown, fallback: boolean): boolean {
	return typeof v === "boolean" ? v : fallback;
}

function strArr(v: unknown): string[] {
	return Array.isArray(v) ? v.map((x) => str(x)).filter((s) => s.length > 0) : [];
}

function imgArr(v: unknown): { src: string; alt: string }[] {
	if (!Array.isArray(v)) return [];
	return v
		.map((x) => {
			const o = (x ?? {}) as Record<string, unknown>;
			const src = str(o.src);
			return src ? { src, alt: str(o.alt) } : null;
		})
		.filter((x): x is { src: string; alt: string } => x !== null);
}

async function readDoc(abs: string): Promise<Record<string, unknown> | null> {
	if (!(await exists(abs))) return null;
	const raw = await fs.readFile(abs, "utf8");
	return parseFrontmatter(raw).data;
}

async function uniqueDir(base: string, name: string): Promise<string> {
	let candidate = name;
	let i = 2;
	while (await exists(path.join(base, candidate))) {
		candidate = `${name}-${i}`;
		i += 1;
	}
	return candidate;
}

/* ---------- 文章 ---------- */

function normPostMeta(data: Record<string, unknown>, slug: string, rel: string, layout: PostMeta["layout"]): PostMeta {
	return {
		slug,
		path: rel,
		layout,
		title: str(data.title, slug),
		published: str(data.published, todayShanghai()).slice(0, 10),
		publishedAt: strOrUndef(data.publishedAt),
		updated: strOrUndef(data.updated),
		updatedAt: strOrUndef(data.updatedAt),
		description: str(data.description),
		image: str(data.image),
		category: str(data.category),
		tags: strArr(data.tags),
		pinned: bool(data.pinned, false),
		draft: bool(data.draft, false),
		comment: bool(data.comment, true),
		encrypted: bool(data.encrypted, false),
		hasPassword: Boolean(data.password),
		passwordHint: str(data.passwordHint),
		hideHomeContent: bool(data.hideHomeContent, true),
		alias: strOrUndef(data.alias),
		permalink: strOrUndef(data.permalink),
	};
}

function slugOfRel(rel: string): { slug: string; layout: PostMeta["layout"] } {
	const norm = rel.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/index.md");
	if (idx > 0) return { slug: norm.slice(0, idx), layout: "directory" };
	return { slug: norm.replace(/\.mdx?$/i, ""), layout: "file" };
}

/** 补上文件修改时间（列表展示兜底用，不参与 frontmatter 序列化） */
async function withMtime(meta: PostMeta, abs: string): Promise<PostMeta> {
	const st = await fs.stat(abs).catch(() => null);
	if (st) meta.mtime = shanghaiMomentStamp(st.mtime);
	return meta;
}

export async function listPosts(): Promise<PostMeta[]> {
	const out: PostMeta[] = [];
	const entries = await fs.readdir(POSTS_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const abs = path.join(POSTS_DIR, entry.name, "index.md");
			const data = await readDoc(abs);
			if (data) out.push(await withMtime(normPostMeta(data, entry.name, `${entry.name}/index.md`, "directory"), abs));
		} else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name) && !/^index\.md$/i.test(entry.name)) {
			const rel = entry.name;
			const abs = path.join(POSTS_DIR, entry.name);
			const data = await readDoc(abs);
			if (data) {
				out.push(await withMtime(normPostMeta(data, slugOfRel(rel).slug, rel, "file"), abs));
			}
		}
	}
	return out.sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return b.published.localeCompare(a.published);
	});
}

export async function readPost(rel: string): Promise<PostFile> {
	const abs = within(POSTS_DIR, rel);
	if (!/\.(md|mdx)$/i.test(abs)) throw new ApiError(400, "只能读取 Markdown 文件");
	const raw = await fs.readFile(abs, "utf8").catch(() => {
		throw new ApiError(404, `文章不存在：${rel}`);
	});
	const parsed = parseFrontmatter(raw);
	const { slug, layout } = slugOfRel(rel);
	const meta = await withMtime(normPostMeta(parsed.data, slug, rel.replace(/\\/g, "/"), layout), abs);
	return { meta, body: parsed.body };
}

export async function createPost(input: CreatePostInput): Promise<PostFile> {
	const title = input.title.trim();
	if (!title) throw new ApiError(400, "标题不能为空");
	const suggested = input.slug ? sanitizeUserSlug(input.slug) : suggestSlug(title);
	const slug = await uniqueDir(POSTS_DIR, suggested.slug);
	const dir = path.join(POSTS_DIR, slug);
	await fs.mkdir(dir, { recursive: true });
	const meta: PostMeta = {
		slug,
		path: `${slug}/index.md`,
		layout: "directory",
		title,
		published: todayShanghai(),
		description: "",
		image: "",
		category: "",
		tags: [],
		pinned: false,
		draft: true,
		comment: true,
		encrypted: false,
		hasPassword: false,
		passwordHint: "",
		hideHomeContent: true,
	};
	const doc: Record<string, unknown> = {
		title,
		published: meta.published,
		description: "",
		image: "",
		category: "",
		tags: [],
		pinned: false,
		draft: true,
		comment: true,
		encrypted: false,
		hideHomeContent: true,
	};
	await fs.writeFile(path.join(dir, "index.md"), serializeFrontmatter(doc, POST_ORDER, ""));
	return { meta, body: "" };
}

const META_KEYS = [
	"title",
	"published",
	"publishedAt",
	"updated",
	"updatedAt",
	"description",
	"image",
	"category",
	"tags",
	"pinned",
	"draft",
	"comment",
	"encrypted",
	"passwordHint",
	"hideHomeContent",
	"alias",
	"permalink",
] as const;

export async function savePost(input: SavePostInput): Promise<PostFile> {
	const abs = within(POSTS_DIR, input.path);
	const existingRaw = await fs.readFile(abs, "utf8").catch(() => {
		throw new ApiError(404, `文章不存在：${input.path}`);
	});
	const existing = parseFrontmatter(existingRaw);
	const next: Record<string, unknown> = { ...existing.data };
	const m = (input.meta ?? {}) as Record<string, unknown>;

	for (const key of META_KEYS) {
		if (!(key in m)) continue;
		const v = m[key];
		switch (key) {
			case "tags":
				next.tags = strArr(v);
				break;
			case "publishedAt":
			case "updated":
			case "updatedAt":
			case "alias":
			case "permalink": {
				const s = strOrUndef(v);
				if (s) next[key] = s;
				else delete next[key];
				break;
			}
			default:
				next[key] = v;
		}
	}
	if (input.clearPassword) delete next.password;
	else if (typeof input.password === "string" && input.password !== "") next.password = input.password;
	if (next.encrypted === false) {
		delete next.password;
		delete next.passwordHint;
		next.hideHomeContent = bool(next.hideHomeContent, true);
	}

	await fs.mkdir(path.dirname(abs), { recursive: true });
	await fs.writeFile(abs, serializeFrontmatter(next, POST_ORDER, input.body));
	await cleanPostImages(slugOfRel(input.path).slug, [input.body, str(next.image)]);
	// 导航里拖入该文章生成的快照链接跟随改名 / 换 permalink
	await syncNavbarPostLinks({
		slug: slugOfRel(input.path).slug,
		oldTitle: str(existing.data.title),
		newTitle: str(next.title),
		oldPermalink: strOrUndef(existing.data.permalink),
		newPermalink: strOrUndef(next.permalink),
	});
	return readPost(input.path);
}

export async function deletePost(rel: string): Promise<void> {
	const abs = within(POSTS_DIR, rel);
	const st = await fs.stat(abs).catch(() => {
		throw new ApiError(404, `文章不存在：${rel}`);
	});
	const doc = await readDoc(st.isDirectory() ? path.join(abs, "index.md") : abs);
	if (st.isDirectory()) {
		if (rel.replace(/\\/g, "/").split("/").length !== 1) {
			throw new ApiError(400, "删除目录形式的文章只能传 slug 顶层目录");
		}
		await fs.rm(abs, { recursive: true, force: true });
	} else {
		await fs.unlink(abs);
	}
	if (doc) await removeNavbarPostLinks(slugOfRel(rel).slug, strOrUndef(doc.permalink));
}

/* ---------- 说说 ---------- */

function normMomentMeta(data: Record<string, unknown>, id: string, body = ""): MomentMeta {
	return {
		id,
		path: `${id}.md`,
		published: str(data.published),
		pinned: bool(data.pinned, false),
		location: str(data.location),
		mood: str(data.mood),
		tags: strArr(data.tags),
		images: imgArr(data.images),
		draft: bool(data.draft, false),
		body,
	};
}

export async function listMoments(): Promise<MomentMeta[]> {
	const out: MomentMeta[] = [];
	const entries = await fs.readdir(MOMENTS_DIR, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.isFile() && /\.md$/i.test(entry.name)) {
			const abs = path.join(MOMENTS_DIR, entry.name);
			const raw = await fs.readFile(abs, "utf8").catch(() => "");
			if (!raw) continue;
			const parsed = parseFrontmatter(raw);
			out.push(normMomentMeta(parsed.data, entry.name.replace(/\.md$/i, ""), parsed.body));
		}
	}
	return out.sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return b.published.localeCompare(a.published);
	});
}

export async function readMoment(rel: string): Promise<MomentFile> {
	const abs = within(MOMENTS_DIR, rel);
	const raw = await fs.readFile(abs, "utf8").catch(() => {
		throw new ApiError(404, `说说不存在：${rel}`);
	});
	const parsed = parseFrontmatter(raw);
	const id = path.basename(rel).replace(/\.md$/i, "");
	return { meta: normMomentMeta(parsed.data, id, parsed.body), body: parsed.body };
}

function momentData(input: MomentInput): Record<string, unknown> {
	return {
		published: input.published,
		pinned: input.pinned ?? false,
		location: input.location ?? "",
		mood: input.mood ?? "",
		tags: input.tags ?? [],
		images: (input.images ?? []).map((i) => ({ src: i.src, alt: i.alt ?? "" })),
		draft: input.draft ?? false,
	};
}

function assertMomentPublished(v: string): string {
	const s = v.trim().replace("T", " ");
	if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
		throw new ApiError(400, "说说的 published 必须是 YYYY-MM-DD HH:mm:ss");
	}
	return s;
}

export async function createMoment(input: MomentInput): Promise<MomentFile> {
	const published = assertMomentPublished(input.published);
	const id = await uniqueDir(MOMENTS_DIR, momentId(published));
	await fs.mkdir(MOMENTS_DIR, { recursive: true });
	await fs.writeFile(path.join(MOMENTS_DIR, `${id}.md`), serializeFrontmatter(momentData({ ...input, published }), MOMENT_ORDER, input.body));
	return readMoment(`${id}.md`);
}

export async function updateMoment(rel: string, input: MomentInput): Promise<MomentFile> {
	const abs = within(MOMENTS_DIR, rel);
	await fs.access(abs).catch(() => {
		throw new ApiError(404, `说说不存在：${rel}`);
	});
	const published = assertMomentPublished(input.published);
	await fs.writeFile(abs, serializeFrontmatter(momentData({ ...input, published }), MOMENT_ORDER, input.body));
	return readMoment(rel);
}

export async function deleteMoment(rel: string): Promise<void> {
	const abs = within(MOMENTS_DIR, rel);
	if (!/\.md$/i.test(abs)) throw new ApiError(400, "只能删除说说 md 文件");
	await fs.unlink(abs).catch(() => {
		throw new ApiError(404, `说说不存在：${rel}`);
	});
}

/* ---------- 媒体上传 ---------- */

function asciiName(orig: string): string {
	const ext = path.extname(orig).toLowerCase();
	const base = path
		.basename(orig, path.extname(orig))
		.replace(/[\s_]+/g, "-")
		.replace(/[^\w-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
	return `${base || "img"}${ext}`;
}

async function uniqueFile(dir: string, name: string): Promise<string> {
	const ext = path.extname(name);
	const base = path.basename(name, ext);
	let candidate = `${base}${ext}`;
	let i = 1;
	while (await exists(path.join(dir, candidate))) {
		i += 1;
		candidate = `${base}-${i}${ext}`;
	}
	return candidate;
}

/** 清掉目录内与 base 同基名（任意扩展名）的旧文件：原位替换时扩展名变化不留孤儿 */
async function cleanSameBase(dir: string, base: string): Promise<void> {
	for (const old of await fs.readdir(dir).catch(() => [] as string[])) {
		if (path.basename(old, path.extname(old)) === base) {
			await fs.unlink(path.join(dir, old)).catch(() => {});
		}
	}
}

/**
 * 解析槽位上传的目标文件名：
 * - fixedName：固定名单槽位（favicon 按主题定名），原位覆盖；
 * - current（字段当前值）指向本托管目录内文件：沿用旧文件名原位替换，扩展名以新上传为准；
 * - 否则按上传文件名生成不重名新文件（newPrefix 可加前缀）。
 */
async function resolveSlotFileName(
	dir: string,
	srcPrefix: string,
	current: string,
	origName: string,
	opts: { fixedName?: string; newPrefix?: string } = {},
): Promise<string> {
	const ext = path.extname(origName).toLowerCase();
	if (opts.fixedName && /^[\w-]+$/.test(opts.fixedName)) {
		await cleanSameBase(dir, opts.fixedName);
		return `${opts.fixedName}${ext}`;
	}
	let base = "";
	const c = current.trim();
	if (c.startsWith(`${srcPrefix}/`)) {
		const rest = c.slice(srcPrefix.length + 1).replace(/\\/g, "/");
		if (/^[\w-]+(?:\/[\w-]+)*\.[a-z0-9]+$/.test(rest)) {
			base = path.basename(rest, path.extname(rest));
		}
	}
	if (base) {
		await cleanSameBase(dir, base);
		return `${base}${ext}`;
	}
	return uniqueFile(dir, opts.newPrefix ? `${opts.newPrefix}-${asciiName(origName)}` : asciiName(origName));
}

/**
 * 文章配图统一编号命名 image<N>.<ext>：N 取目录内现有最大编号 +1，
 * alt 返回 图片<N> 供编辑器插入。wx 原子占位防并行上传撞号。
 */
export async function uploadPostImage(slug: string, origName: string, buf: Buffer): Promise<MediaUploadResult> {
	if (!/^[\w-]+$/.test(slug)) throw new ApiError(400, `slug 不合法：${slug}`);
	const dir = path.join(POSTS_DIR, slug, "images");
	await fs.mkdir(dir, { recursive: true });
	const ext = path.extname(origName).toLowerCase() || ".png";
	let max = 0;
	for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
		const m = /^image(\d+)\.[^.]+$/.exec(f);
		if (m) max = Math.max(max, Number(m[1]));
	}
	let n = max + 1;
	for (;;) {
		const fileName = `image${n}${ext}`;
		try {
			await fs.writeFile(path.join(dir, fileName), buf, { flag: "wx" });
			return { src: `./images/${fileName}`, fileName, alt: `图片${n}` };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				n += 1;
				continue;
			}
			throw e;
		}
	}
}

/** 保存时清理文章配图目录里不再被正文/封面引用的孤儿图（跳过刚上传的，防插图竞态误删） */
async function cleanPostImages(slug: string, refs: string[]): Promise<void> {
	const dir = path.join(POSTS_DIR, slug, "images");
	const files = await fs.readdir(dir).catch(() => [] as string[]);
	const now = Date.now();
	for (const f of files) {
		if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) continue;
		if (refs.some((r) => r.includes(f))) continue;
		const st = await fs.stat(path.join(dir, f)).catch(() => null);
		if (!st || now - st.mtimeMs < 120_000) continue;
		await fs.unlink(path.join(dir, f)).catch(() => {});
	}
}

export async function uploadMomentImage(batchId: string | undefined, origName: string, buf: Buffer): Promise<MediaUploadResult> {
	const ext = path.extname(origName).toLowerCase();
	if (!IMAGE_EXT.has(ext)) throw new ApiError(400, `不支持的图片格式：${ext}`);
	const batchBase = momentId(shanghaiMomentStamp());
	const batch = batchId && /^[\w-]+$/.test(batchId) ? batchId : await uniqueDir(MOMENT_IMAGES_DIR, batchBase);
	const dir = path.join(MOMENT_IMAGES_DIR, batch);
	await fs.mkdir(dir, { recursive: true });
	const files = (await fs.readdir(dir)).filter((f) => IMAGE_EXT.has(path.extname(f).toLowerCase()));
	const seq = String(files.length + 1).padStart(2, "0");
	const fileName = `${seq}${ext}`;
	await fs.writeFile(path.join(dir, fileName), buf);
	return { src: `/images/moments/${batch}/${fileName}`, fileName, batchId: batch };
}

/* ---------- 站点图片上传（横幅 / 头像 / favicon）---------- */

interface SiteImageTarget {
	root: "assets" | "public";
	rel: string;
	exts?: Set<string>;
}

const SITE_IMAGE_TARGETS: Record<string, SiteImageTarget> = {
	"banner-desktop": { root: "assets", rel: "images/banner/desktop" },
	"banner-mobile": { root: "assets", rel: "images/banner/mobile" },
	avatar: { root: "assets", rel: "images/avatar" },
	// footer.html 经 set:html 原样注入，不走资源管线；assets/ 下的 src 线上 404，必须落 public/
	footer: { root: "public", rel: "images/footer" },
	favicon: { root: "public", rel: "favicon", exts: new Set([...IMAGE_EXT, ".ico", ".svg"]) },
};

export async function uploadSiteImage(
	target: string,
	origName: string,
	buf: Buffer,
	/** 固定文件名（不含扩展名）：favicon 单槽位资源按主题定名，重复上传原位覆盖替换 */
	fixedName?: string,
	/** 字段当前值（相对路径或在线 URL）：指向本目标托管目录时原位替换旧文件（如头像） */
	currentSrc?: string,
): Promise<SiteMediaResult> {
	const t = SITE_IMAGE_TARGETS[target];
	if (!t) throw new ApiError(400, `未知上传目标：${target}`);
	const allowed = t.exts ?? IMAGE_EXT;
	const ext = path.extname(origName).toLowerCase();
	if (!allowed.has(ext)) throw new ApiError(400, `不支持的图片格式：${ext}`);
	const root = t.root === "assets" ? ASSETS_DIR : PUBLIC_DIR;
	const dir = path.join(root, ...t.rel.split("/"));
	await fs.mkdir(dir, { recursive: true });
	const srcPrefix = (t.root === "assets" ? "assets/" : "/") + t.rel;
	const fileName = await resolveSlotFileName(dir, srcPrefix, currentSrc ?? "", origName, { fixedName });
	await fs.writeFile(path.join(dir, fileName), buf);
	if (target === "footer") await deleteLegacyFooterImage(currentSrc ?? "");
	const rel = `${t.rel}/${fileName}`;
	return {
		src: t.root === "assets" ? `assets/${rel}` : `/${rel}`,
		previewUrl: (t.root === "assets" ? "/content-assets/" : "/content-public/") + rel,
		fileName,
	};
}

/** footer 托管目录的旧位置（src 前缀 assets/，线上 404 已弃用）：替换时清理遗留旧文件 */
async function deleteLegacyFooterImage(src: string): Promise<void> {
	if (!src.startsWith("assets/images/footer/")) return;
	try {
		await fs.unlink(within(ASSETS_DIR, src.slice("assets/".length)));
	} catch {
		// 已不存在等情形视为已清理
	}
}

/** 站点图片托管目录清单（页脚图片库）：只列图片文件，按文件名排序 */
export async function listSiteImages(target: string): Promise<SiteMediaResult[]> {
	const t = SITE_IMAGE_TARGETS[target];
	if (!t) throw new ApiError(400, `未知上传目标：${target}`);
	const dir = path.join(t.root === "assets" ? ASSETS_DIR : PUBLIC_DIR, ...t.rel.split("/"));
	const files = (await fs.readdir(dir).catch(() => [] as string[]))
		.filter((f) => (t.exts ?? IMAGE_EXT).has(path.extname(f).toLowerCase()))
		.sort();
	return files.map((fileName) => {
		const rel = `${t.rel}/${fileName}`;
		return {
			src: t.root === "assets" ? `assets/${rel}` : `/${rel}`,
			previewUrl: (t.root === "assets" ? "/content-assets/" : "/content-public/") + rel,
			fileName,
		};
	});
}

/* ---------- 自定义图标图片上传（导航菜单 / 数据条目的图标字段）---------- */

const ICON_IMAGE_EXT = new Set([...IMAGE_EXT, ".svg", ".ico"]);

/**
 * 上传自定义图标图片：落 public/images/icons/（public 原样发布，线上直链可用）。
 * currentSrc 指向该托管目录内文件时原位替换（沿用文件名，扩展名以新上传为准）。
 */
export async function uploadIconImage(
	currentSrc: string | undefined,
	origName: string,
	buf: Buffer,
): Promise<SiteMediaResult> {
	const ext = path.extname(origName).toLowerCase();
	if (!ICON_IMAGE_EXT.has(ext)) throw new ApiError(400, `不支持的图片格式：${ext || "（无扩展名）"}`);
	const dir = path.join(PUBLIC_DIR, "images", "icons");
	await fs.mkdir(dir, { recursive: true });
	const fileName = await resolveSlotFileName(dir, "/images/icons", currentSrc ?? "", origName, {
		newPrefix: "icon",
	});
	await fs.writeFile(path.join(dir, fileName), buf);
	const rel = `images/icons/${fileName}`;
	return { src: `/${rel}`, previewUrl: `/content-public/${rel}`, fileName };
}

/* ---------- 站点横幅壁纸清理（保存配置时物理删除不再引用的本地文件）---------- */

/** 横幅壁纸托管目录的 src 前缀（与 SITE_IMAGE_TARGETS 的 banner 槽位一致） */
const BANNER_SRC_PREFIXES = ["assets/images/banner/desktop/", "assets/images/banner/mobile/"];

/**
 * 物理删除横幅壁纸本地文件：仅接受指向托管目录内的 src（在线地址与目录外路径一律跳过），
 * 路径经 resolve 校验防穿越；文件不存在或删除失败静默，不阻断保存。
 */
export async function deleteSiteBannerImage(src: string): Promise<void> {
	if (!BANNER_SRC_PREFIXES.some((p) => src.startsWith(p))) return;
	try {
		await fs.unlink(within(ASSETS_DIR, src.slice("assets/".length)));
	} catch {
		// 已不存在等情形视为已清理
	}
}

/* ---------- 数据封面上传（数据管理各类条目的图片字段）---------- */

interface DataCoverTarget {
	root: "assets" | "public";
	/** 内容仓内相对目录（/ 分隔） */
	rel: string;
}

/** 各数据类型封面文件的托管目录；src 前缀由 root 推导，与主题引用约定一致 */
const DATA_COVER_TARGETS: Record<string, DataCoverTarget> = {
	anime: { root: "public", rel: "assets/anime" },
	projects: { root: "public", rel: "assets/projects" },
	devices: { root: "public", rel: "images/devices" },
	friends: { root: "public", rel: "images/friends" },
	music: { root: "assets", rel: "images/music" },
};

/**
 * 上传数据条目封面。currentPath 指向该类型托管目录内的文件时原位覆盖（沿用文件名，
 * 扩展名以新上传为准并清掉旧扩展名文件），否则按上传文件名生成不重名新文件。
 */
export async function uploadDataCover(
	kind: string,
	currentPath: string | undefined,
	origName: string,
	buf: Buffer,
): Promise<SiteMediaResult> {
	const t = DATA_COVER_TARGETS[kind];
	if (!t) throw new ApiError(400, `该数据类型暂不支持图片上传：${kind}`);
	const ext = path.extname(origName).toLowerCase();
	if (!IMAGE_EXT.has(ext)) throw new ApiError(400, `不支持的图片格式：${ext}`);
	const root = t.root === "assets" ? ASSETS_DIR : PUBLIC_DIR;
	const dir = path.join(root, ...t.rel.split("/"));
	await fs.mkdir(dir, { recursive: true });

	const srcPrefix = (t.root === "assets" ? "assets/" : "/") + t.rel;
	const fileName = await resolveSlotFileName(dir, srcPrefix, currentPath ?? "", origName, { newPrefix: "cover" });
	await fs.writeFile(path.join(dir, fileName), buf);
	const rel = `${t.rel}/${fileName}`;
	return {
		src: t.root === "assets" ? `assets/${rel}` : `/${rel}`,
		previewUrl: (t.root === "assets" ? "/content-assets/" : "/content-public/") + rel,
		fileName,
	};
}

/* ---------- 音乐音频上传（歌单曲目音频文件）---------- */

const AUDIO_EXT = new Set([".mp3", ".ogg", ".oga", ".opus", ".wav", ".flac", ".m4a", ".aac"]);

/**
 * 上传歌单曲目音频：落 public/assets/music/url/（主题音乐播放器的约定目录）。
 * currentSrc 指向该目录内文件时原位替换（沿用文件名，扩展名以新上传为准）。
 */
export async function uploadMusicAudio(
	origName: string,
	buf: Buffer,
	currentSrc?: string,
): Promise<SiteMediaResult> {
	const ext = path.extname(origName).toLowerCase();
	if (!AUDIO_EXT.has(ext)) throw new ApiError(400, `不支持的音频格式：${ext || "（无扩展名）"}`);
	const dir = path.join(PUBLIC_DIR, "assets", "music", "url");
	await fs.mkdir(dir, { recursive: true });
	const fileName = await resolveSlotFileName(dir, "/assets/music/url", currentSrc ?? "", origName);
	await fs.writeFile(path.join(dir, fileName), buf);
	const rel = `assets/music/url/${fileName}`;
	return {
		src: `/${rel}`,
		previewUrl: `/content-public/${rel}`,
		fileName,
	};
}
