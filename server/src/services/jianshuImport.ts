import { randomUUID } from "node:crypto";
import path from "node:path";
import AdmZip from "adm-zip";
import { parse } from "node-html-parser";
import { createExtractorFromData, UnrarError } from "node-unrar-js";
import { z } from "zod";
import type {
	JianshuArchiveSummary,
	JianshuArticleRef,
	JianshuImportJob,
	JianshuImportOptions,
	JianshuImportResult,
	JianshuMetaSuggestion,
	JianshuNotebook,
	JianshuPasteInput,
	JianshuPasteOptions,
	JianshuPasteResult,
	JianshuPreview,
} from "@shirone-admin/shared";
import * as storage from "../adapters/storage.js";
import { ApiError } from "../lib/errors.js";
import {
	collapseWs,
	contentHtmlToMarkdown,
	countWords,
	excerptText,
	parseJianshuArticle,
	rewriteImages,
} from "../lib/jianshuHtml.js";
import { convertWebpIfNeeded, downloadRemoteImage } from "./remoteMedia.js";
import { callAiChat, fastModel, loadAiSettings } from "./aiSettings.js";

/**
 * 简书官方导出包导入：会话（内存态解包结果）+ 后台导入任务。
 *
 * 会话与任务都只在内存里（单机单用户工具，重启即失效——客户端轮询 404 时提示重传即可），
 * 不落 tmpdir：归档上传受 multipart 30MB 限制，解包内容全量驻留内存更简单也无残留清理负担。
 */

const UNGROUPED = "未分组";

/** 保留 .html 与图片（个别导出变体带包内图片，导入时兜底落仓） */
const KEEP_EXT = /\.(html?|webp|png|jpe?g|gif|avif)$/i;
const HTML_EXT = /\.html?$/i;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
/** 会话保留 24h、最多 3 个（LRU 淘汰，运行中不踢）；完成任务保留 1h */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS = 3;

interface Session {
	id: string;
	createdAt: number;
	/** 归一化（/ 分隔）包内相对路径 → 内容 */
	files: Map<string, Buffer>;
	notebooks: JianshuNotebook[];
	/** 文章 id → 文集名（清单展示与导入分类用） */
	notebookById: Map<string, string>;
	runningJobId?: string;
	importedIds: Set<string>;
}

interface InternalJob extends JianshuImportJob {
	completedAt?: number;
}

const sessions = new Map<string, Session>();
const jobs = new Map<string, InternalJob>();

/* ---------- 解包 ---------- */

/** 条目名归一：\ → /、拒目录/绝对路径/盘符/../ 空段（zip-slip 防护）；不合法返回 null */
function normalizeEntryName(name: string): string | null {
	const norm = name.replace(/\\/g, "/").replace(/^\.\//, "");
	if (!norm || norm.endsWith("/")) return null;
	if (/^([a-zA-Z]:)?\//.test(norm)) return null;
	const segs = norm.split("/");
	if (segs.some((s) => s === ".." || s === "")) return null;
	return norm;
}

function extractZip(buf: Buffer): Map<string, Buffer> {
	const zip = new AdmZip(buf);
	const entries = zip.getEntries();
	if (entries.length > MAX_ENTRIES) {
		throw new ApiError(400, `压缩包条目过多（${entries.length}），疑似异常文件`);
	}
	const files = new Map<string, Buffer>();
	let total = 0;
	for (const entry of entries) {
		if (entry.isDirectory) continue;
		const size = entry.header.size;
		if (size > MAX_FILE_BYTES) throw new ApiError(400, `压缩包内文件过大：${entry.entryName}`);
		total += size;
		if (total > MAX_TOTAL_BYTES) throw new ApiError(400, "解压内容总量超过 300MB，已拒绝");
		const name = normalizeEntryName(entry.entryName);
		if (!name || !KEEP_EXT.test(name)) continue;
		files.set(name, Buffer.from(entry.getData()));
	}
	return files;
}

function mapUnrarError(e: unknown): ApiError {
	if (e instanceof UnrarError) {
		if (e.reason === "ERAR_MISSING_PASSWORD" || e.reason === "ERAR_BAD_PASSWORD") {
			return new ApiError(400, "压缩包带密码，暂不支持");
		}
		if (e.reason === "ERAR_BAD_ARCHIVE" || e.reason === "ERAR_UNKNOWN_FORMAT") {
			return new ApiError(400, "不是有效的 rar 文件");
		}
		return new ApiError(400, `rar 解压失败（${e.reason}）`);
	}
	return new ApiError(502, `rar 解压失败：${(e as Error).message}`);
}

async function extractRar(buf: Buffer): Promise<Map<string, Buffer>> {
	// Buffer 是池化视图，必须拷出独立 ArrayBuffer（不能直接传 buf.buffer）
	const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
	let extractor: Awaited<ReturnType<typeof createExtractorFromData>>;
	try {
		extractor = await createExtractorFromData({ data });
	} catch (e) {
		throw mapUnrarError(e);
	}
	const files = new Map<string, Buffer>();
	try {
		const list = extractor.getFileList();
		// fileHeaders 是惰性生成器，必须完整 drain（否则底层 C++ 对象不析构）
		const headers = [...list.fileHeaders];
		if (list.arcHeader.flags.volume) throw new ApiError(400, "不支持分卷 rar，请合并为单卷后重传");
		if (headers.length > MAX_ENTRIES) throw new ApiError(400, `压缩包条目过多（${headers.length}），疑似异常文件`);
		let total = 0;
		for (const h of headers) {
			if (h.flags.directory) continue;
			if (h.unpSize > MAX_FILE_BYTES) throw new ApiError(400, `压缩包内文件过大：${h.name}`);
			total += h.unpSize;
		}
		if (total > MAX_TOTAL_BYTES) throw new ApiError(400, "解压内容总量超过 300MB，已拒绝");
		const extracted = extractor.extract({});
		for (const f of extracted.files) {
			if (!f.extraction) continue;
			const name = normalizeEntryName(f.fileHeader.name);
			if (!name || !KEEP_EXT.test(name)) continue;
			files.set(name, Buffer.from(f.extraction));
		}
	} catch (e) {
		if (e instanceof ApiError) throw e;
		throw mapUnrarError(e);
	}
	return files;
}

/* ---------- 清单 ---------- */

/**
 * 下钻唯一的包装目录（导出包外层 user-xxx）：所有 html 同前缀、且去掉前缀后仍有更深层目录时进入。
 * 单文集包（全部 html 直接在「文集名/」下）不会被误剥——剥掉后无更深目录即停。
 */
function stripWrapper(htmls: string[]): string[] {
	let cur = htmls;
	for (;;) {
		const prefixes = new Set(cur.map((p) => p.split("/")[0]));
		if (prefixes.size !== 1) break;
		const only = [...prefixes][0];
		if (!cur.every((p) => p.length > only.length + 1 && p.indexOf("/", only.length + 1) !== -1)) break;
		cur = cur.map((p) => p.slice(only.length + 1));
	}
	return cur;
}

function buildNotebooks(files: Map<string, Buffer>): { notebooks: JianshuNotebook[]; notebookById: Map<string, string> } {
	// id 必须是会话 files 的原始键；包装层只影响「显示路径」（文集名归属）
	const originals = [...files.keys()].filter((k) => HTML_EXT.test(k));
	const display = stripWrapper(originals);
	const groups = new Map<string, JianshuArticleRef[]>();
	const notebookById = new Map<string, string>();
	const zh = (a: string, b: string) => a.localeCompare(b, "zh-Hans-CN");
	for (let i = 0; i < originals.length; i++) {
		const id = originals[i];
		const segs = display[i].split("/");
		const notebook = segs.length > 1 ? segs[0] : UNGROUPED;
		const buf = files.get(id);
		if (!buf) continue;
		const { title } = parseJianshuArticle(buf.toString("utf8"), segs[segs.length - 1]);
		notebookById.set(id, notebook);
		const list = groups.get(notebook) ?? [];
		list.push({ id, title, bytes: buf.byteLength });
		groups.set(notebook, list);
	}
	const notebooks = [...groups.entries()]
		.filter(([, articles]) => articles.length > 0)
		.map(([name, articles]) => ({ name, articles: articles.sort((a, b) => zh(a.title, b.title) || zh(a.id, b.id)) }))
		.sort((a, b) => zh(a.name, b.name));
	return { notebooks, notebookById };
}

function summaryOf(session: Session): JianshuArchiveSummary {
	return {
		sessionId: session.id,
		notebooks: session.notebooks,
		total: session.notebooks.reduce((n, nb) => n + nb.articles.length, 0),
		importedIds: [...session.importedIds],
	};
}

/* ---------- 会话与任务管理 ---------- */

function isSessionRunning(session: Session): boolean {
	return Boolean(session.runningJobId && jobs.get(session.runningJobId)?.status === "running");
}

/** 过期清扫（会话 24h / 完成任务 1h）+ 会话数 LRU（运行中的不踢） */
function sweep(): void {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (now - s.createdAt > SESSION_TTL_MS && !isSessionRunning(s)) sessions.delete(id);
	}
	for (const [id, j] of jobs) {
		if (j.status === "done" && j.completedAt && now - j.completedAt > JOB_TTL_MS) jobs.delete(id);
	}
	while (sessions.size > MAX_SESSIONS) {
		const victim = [...sessions.values()]
			.filter((s) => !isSessionRunning(s))
			.sort((a, b) => a.createdAt - b.createdAt)[0];
		if (!victim) break;
		sessions.delete(victim.id);
	}
}

setInterval(sweep, 10 * 60 * 1000).unref();

function requireSession(id: string): Session {
	const session = sessions.get(id);
	if (!session) throw new ApiError(404, "导入会话不存在或已过期，请重新上传压缩包");
	return session;
}

export async function ingestArchive(fileName: string, buf: Buffer): Promise<JianshuArchiveSummary> {
	const ext = path.extname(fileName).toLowerCase();
	if (ext !== ".zip" && ext !== ".rar") {
		throw new ApiError(400, "只支持简书导出的 rar / zip 压缩包");
	}
	const files = ext === ".zip" ? extractZip(buf) : await extractRar(buf);
	if (![...files.keys()].some((k) => HTML_EXT.test(k))) {
		throw new ApiError(400, "包内没有找到 HTML 文章，请确认上传的是简书「打包下载全部文章」导出的压缩包");
	}
	const { notebooks, notebookById } = buildNotebooks(files);
	sweep();
	const session: Session = {
		id: randomUUID(),
		createdAt: Date.now(),
		files,
		notebooks,
		notebookById,
		importedIds: new Set(),
	};
	sessions.set(session.id, session);
	sweep();
	return summaryOf(session);
}

export function previewArticle(sessionId: string, articleId: string): JianshuPreview {
	const session = requireSession(sessionId);
	const buf = session.files.get(articleId);
	if (!buf || !HTML_EXT.test(articleId)) throw new ApiError(404, "文章不存在");
	const fallback = articleId.split("/").pop() ?? "未命名文章";
	const parsed = parseJianshuArticle(buf.toString("utf8"), fallback);
	const { markdown, imageUrls } = contentHtmlToMarkdown(parsed.contentHtml);
	return {
		title: parsed.title,
		markdown,
		imageCount: imageUrls.length,
		wordCount: countWords(parsed.textContent),
	};
}

/* ---------- 导入执行 ---------- */

/** markdown 相对路径图片 → 会话内同路径文件（个别导出变体自带包内图片） */
function resolveRelative(baseDir: string, target: string): string | null {
	const norm = target.replace(/\\/g, "/").split("?")[0].split("#")[0];
	if (norm === "" || /^([a-zA-Z]:)?\//.test(norm)) return null;
	let decoded = norm;
	try {
		decoded = decodeURIComponent(norm);
	} catch {
		// 保留原样
	}
	const segs = [...baseDir.split("/").filter(Boolean), ...decoded.split("/")];
	const out: string[] = [];
	for (const s of segs) {
		if (s === "." || s === "") continue;
		if (s === "..") {
			if (out.length === 0) return null;
			out.pop();
			continue;
		}
		out.push(s);
	}
	return out.join("/");
}

/** 下载远程图片并落仓（webp 自动转 png/jpg）；失败返回 null（保留远程链接） */
async function localizeRemoteImage(slug: string, url: string): Promise<string | null> {
	try {
		const { buf, fileName } = await downloadRemoteImage(url, `jianshu-${slug}`);
		const conv = await convertWebpIfNeeded(fileName, buf);
		const { src } = await storage.uploadPostImage(slug, conv.fileName, conv.buf);
		return src;
	} catch {
		return null;
	}
}

async function importOne(
	session: Session,
	id: string,
	options: JianshuImportOptions,
	push: (line: string) => void,
	slugMap: Map<string, string>,
): Promise<JianshuImportResult> {
	const buf = session.files.get(id)!;
	const fallback = id.split("/").pop() ?? "未命名文章";
	const parsed = parseJianshuArticle(buf.toString("utf8"), fallback);
	const { markdown, imageUrls } = contentHtmlToMarkdown(parsed.contentHtml);

	const post = await storage.createPost({ title: parsed.title, slug: slugMap.get(id) });
	const slug = post.meta.slug;

	let finalMd = markdown;
	let localized = 0;
	const urlMap = new Map<string, string>();
	if (options.localizeImages) {
		// 远程图：下载落仓，失败保留原链接
		for (const url of imageUrls) {
			const src = await localizeRemoteImage(slug, url);
			if (src) {
				urlMap.set(url, src);
				localized += 1;
			} else {
				push(`  ⚠ 图片保留远程链接：${url.slice(0, 100)}`);
			}
		}
		// 包内相对路径图：直接从会话落仓
		const baseDir = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
		const relativeRefs = finalMd.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g);
		for (const m of relativeRefs) {
			const target = m[1].trim();
			if (/^(https?:)?\/\//i.test(target)) continue;
			const resolved = resolveRelative(baseDir, target);
			if (!resolved) continue;
			const imgBuf = session.files.get(resolved);
			if (!imgBuf) continue;
			const name = resolved.split("/").pop() ?? "image";
			const { src } = await storage.uploadPostImage(slug, name, imgBuf);
			finalMd = finalMd.split(target).join(src);
			localized += 1;
		}
		finalMd = rewriteImages(finalMd, urlMap);
	}

	await storage.savePost({
		path: post.meta.path,
		meta: {
			title: parsed.title,
			published: options.published,
			description: excerptText(parsed.textContent, 100),
			image: [...urlMap.values()][0] ?? "",
			category: options.categoryFromNotebook ? (session.notebookById.get(id) ?? "") : (options.category ?? ""),
			tags: options.tags,
			draft: options.draft,
		},
		body: finalMd,
	});
	return { id, title: parsed.title, ok: true, path: post.meta.path, images: localized };
}

export function startImportJob(
	sessionId: string,
	ids: string[],
	options: JianshuImportOptions,
): { jobId: string } {
	const session = requireSession(sessionId);
	if (isSessionRunning(session)) throw new ApiError(400, "该导入包已有任务进行中，请等完成后再试");
	for (const id of ids) {
		if (!session.files.has(id) || !HTML_EXT.test(id)) throw new ApiError(400, `文章不存在：${id}`);
	}
	const job: InternalJob = {
		id: randomUUID(),
		sessionId,
		status: "running",
		total: ids.length,
		done: 0,
		current: null,
		results: [],
		log: [],
	};
	jobs.set(job.id, job);
	session.runningJobId = job.id;
	void runJob(session, job, ids, options);
	return { jobId: job.id };
}

async function runJob(
	session: Session,
	job: InternalJob,
	ids: string[],
	options: JianshuImportOptions,
): Promise<void> {
	const push = (line: string) => {
		job.log.push(line);
		if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
	};
	push(`开始导入 ${ids.length} 篇文章`);
	// 路径名批量走一次 AI 英文短 slug（上游统一可读），失败/未启用逐篇回退拼音
	const titleList = ids.map((id) => {
		const buf = session.files.get(id)!;
		const fallback = id.split("/").pop() ?? id;
		return { id, title: parseJianshuArticle(buf.toString("utf8"), fallback).title };
	});
	let slugMap = new Map<string, string>();
	if (titleList.length > 0) {
		job.current = "生成路径名（AI）";
		slugMap = await suggestSlugsByAi(titleList);
		if (slugMap.size > 0) push(`已生成 ${slugMap.size} 个英文路径名`);
	}
	for (const id of ids) {
		const fallback = id.split("/").pop() ?? id;
		job.current = fallback;
		try {
			const result = await importOne(session, id, options, push, slugMap);
			job.results.push(result);
			session.importedIds.add(id);
			push(`✓ ${result.title} → ${result.path}${result.images > 0 ? `（本地化 ${result.images} 张图）` : ""}`);
		} catch (e) {
			const msg = (e as Error).message || "未知错误";
			job.results.push({ id, title: fallback, ok: false, error: msg, images: 0 });
			push(`✗ ${fallback}：${msg}`);
		}
		job.done += 1;
		job.current = null;
	}
	job.status = "done";
	job.completedAt = Date.now();
	if (session.runningJobId === job.id) session.runningJobId = undefined;
	const ok = job.results.filter((r) => r.ok).length;
	push(`导入完成：成功 ${ok} / ${job.results.length}`);
}

export function getJob(jobId: string): JianshuImportJob {
	const job = jobs.get(jobId);
	if (!job) throw new ApiError(404, "任务不存在或已过期（server 可能已重启），已导入的文章不受影响");
	return { ...job, results: [...job.results], log: [...job.log] };
}

export function deleteSession(id: string): boolean {
	const session = sessions.get(id);
	if (!session) return true;
	if (isSessionRunning(session)) throw new ApiError(400, "该导入包有任务进行中，不能删除");
	sessions.delete(id);
	return true;
}

/* ---------- 单篇粘贴导入（网页版复制内容，无会话：预览与导入都携带原始粘贴载荷） ---------- */

const PASTE_MAX_CHARS = 2 * 1024 * 1024;

/** 粘贴片段额外剔除的页面噪音：评论区/推荐位等（线上页面 class 是哈希值，只能按关键词兜底） */
const PASTE_NOISE_SELECTOR = "[id*=comment],[class*=comment],[class*=Comment],[class*=recommend]";

function requirePastePayload(input: JianshuPasteInput): { html: string; text: string; markdown: string } {
	const html = (input.html ?? "").trim();
	const text = (input.text ?? "").trim();
	const markdown = (input.markdown ?? "").trim();
	if (html === "" && text === "" && markdown === "") throw new ApiError(400, "粘贴内容为空");
	if (html.length + text.length + markdown.length > PASTE_MAX_CHARS) {
		throw new ApiError(400, "粘贴内容过大（超过 2MB）");
	}
	return { html, text, markdown };
}

/** 纯文本兜底时的粗略 markdown → 纯文本（字数与摘要用） */
function markdownToPlain(md: string): string {
	return collapseWs(
		md
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/^[#>]{1,6}\s*/gm, "")
			.replace(/[*_~`|]+/g, " "),
	);
}

/** 粘贴 → 标题 / 正文 markdown / 纯文本 / 图片直链（预览与导入共用同一次转换规则） */
function convertPaste(payload: { html: string; text: string; markdown: string }): {
	title: string;
	markdown: string;
	plain: string;
	imageUrls: string[];
} {
	if (payload.html !== "") {
		const root = parse(payload.html);
		for (const el of root.querySelectorAll(PASTE_NOISE_SELECTOR)) el.remove();
		// 粘贴片段常缺 <title>，且 h1 往往在正文容器外（article 直下）：先在全片段里找标题
		const h1 = collapseWs(root.querySelector("h1")?.textContent ?? "");
		const parsed = parseJianshuArticle(root.outerHTML, "");
		const { markdown, imageUrls } = contentHtmlToMarkdown(parsed.contentHtml);
		const title = h1 || (parsed.title === "未命名文章" ? "" : parsed.title);
		return { title, markdown, plain: parsed.textContent, imageUrls };
	}
	// 编辑器定稿 markdown / 纯文本：按 markdown 处理；首行一级标题可充当文章标题
	let md = (payload.markdown !== "" ? payload.markdown : payload.text).trim();
	let title = "";
	const m = md.match(/^#\s+(.+)\r?\n?/);
	if (m) {
		title = m[1].trim();
		md = md.slice(m[0].length);
	}
	const imageUrls = [...new Set([...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((x) => x[1]))];
	return { title, markdown: md, plain: markdownToPlain(md), imageUrls };
}

export function previewPaste(input: JianshuPasteInput): JianshuPreview {
	const c = convertPaste(requirePastePayload(input));
	return {
		title: c.title,
		markdown: c.markdown,
		imageCount: c.imageUrls.length,
		wordCount: countWords(c.plain),
	};
}

export async function importPaste(
	input: JianshuPasteInput,
	options: JianshuPasteOptions,
): Promise<JianshuPasteResult> {
	const c = convertPaste(requirePastePayload(input));
	const title = options.title.trim();
	if (title === "") throw new ApiError(400, "标题不能为空");

	// 路径名优先 AI 英文短 slug（可读），失败/未启用回退拼音转写
	const aiSlug = await suggestSlugByAi(title, c.markdown);
	const post = await storage.createPost({ title, slug: aiSlug ?? undefined });
	const slug = post.meta.slug;

	// 粘贴导入固定本地化：图片全部下载进文章目录，失败的才保留远程链接
	const urlMap = new Map<string, string>();
	const failedImages: string[] = [];
	for (const url of c.imageUrls) {
		const src = await localizeRemoteImage(slug, url);
		if (src) urlMap.set(url, src);
		else failedImages.push(url);
	}

	await storage.savePost({
		path: post.meta.path,
		meta: {
			title,
			published: options.published,
			description: excerptText(c.plain, 100),
			image: [...urlMap.values()][0] ?? "",
			category: options.category ?? "",
			tags: options.tags,
			draft: options.draft,
		},
		body: rewriteImages(c.markdown, urlMap),
	});
	return { title, path: post.meta.path, slug, images: urlMap.size, failedImages };
}

/* ---------- AI 元信息建议（粘贴导入「文章信息」步回填；AI 未启用/失败回退正文摘要） ---------- */

const SUGGEST_SYSTEM =
	"你是博客文章元信息助手。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏，" +
	'形如 {"description":"…","category":"…","tags":["…"]}。';

/* ---------- AI 英文短 slug（文章目录名；AI 未启用/失败回退拼音转写） ---------- */

const SLUG_SYSTEM =
	"你是 URL slug 生成器。只输出一个 JSON 对象，不要任何解释或代码围栏，形如 {\"slug\":\"…\"}。";

/** AI slug 硬校验：全小写 kebab-case、纯 ASCII、2-48 字符，不合规一律回退 */
function validAiSlug(raw: string): string | null {
	const slug = raw.trim().toLowerCase();
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
	return slug.length >= 2 && slug.length <= 48 ? slug : null;
}

/** 批量版（导出包整批）：一次 AI 调用生成全部 slug；任何失败返回空表，逐篇回退拼音 */
export async function suggestSlugsByAi(
	articles: { id: string; title: string }[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const settings = await loadAiSettings();
	if (!settings.enable || articles.length === 0) return out;
	const CHUNK = 60;
	for (let base = 0; base < articles.length; base += CHUNK) {
		const chunk = articles.slice(base, base + CHUNK);
		try {
			const listing = chunk.map((a, j) => `${base + j + 1}. ${a.title}`).join("\n");
			const result = await callAiChat(settings, {
				messages: [
					{ role: "system", content: SLUG_SYSTEM },
					{
						role: "user",
						content:
							`文章清单：\n${listing}\n\n` +
							"请为每篇文章生成 URL slug：2-4 个概括主题的英文单词，小写 kebab-case（只用小写字母、数字与连字符），不要拼音（专有名词可保留拼音，如 wugongshan）。\n" +
							'必须为清单中每一篇都输出，格式示例：{"1":"softarch-exam-guide","2":"astro-blog-theme","3":"wugongshan-hiking-gear"}\n',
					},
				],
				maxTokens: 2048,
				temperature: 0.2,
				webSearch: false,
				model: fastModel(settings),
				noThink: true,
			});
			const r = z.record(z.string()).safeParse(extractJson(result.content));
			if (!r.success) continue;
			for (const [num, raw] of Object.entries(r.data)) {
				const idx = Number(num) - 1;
				const slug = validAiSlug(raw);
				if (Number.isInteger(idx) && idx >= 0 && idx < articles.length && slug) {
					out.set(articles[idx].id, slug);
				}
			}
		} catch {
			// 本批失败：对应文章由 createPost 回退拼音
		}
	}
	return out;
}

export async function suggestSlugByAi(title: string, markdown: string): Promise<string | null> {
	const settings = await loadAiSettings();
	if (!settings.enable) return null;
	try {
		const result = await callAiChat(settings, {
			messages: [
				{ role: "system", content: SLUG_SYSTEM },
				{
					role: "user",
					content:
						`文章标题：${title}\n\n正文摘要：\n${markdownToPlain(markdown).slice(0, 1500)}\n\n` +
						"请生成这篇文章的 URL slug：2-4 个概括主题的英文单词，小写 kebab-case（只用小写字母、数字与连字符），不要拼音、不要翻译腔。\n",
				},
			],
			maxTokens: 128,
			temperature: 0.2,
			webSearch: false,
			model: fastModel(settings),
			noThink: true,
		});
		const r = z.object({ slug: z.string() }).safeParse(extractJson(result.content));
		return r.success ? validAiSlug(r.data.slug) : null;
	} catch {
		return null;
	}
}

const suggestSchema = z.object({
	title: z.string().trim().min(1).max(100).optional(),
	description: z.string().trim().min(1).max(200),
	category: z.string().trim().max(40),
	tags: z.array(z.string().trim().min(1).max(30)).max(12),
});

/** 宽松提取 AI 输出中的 JSON 对象（孪生实现：timelineDraft.parseTimelineDrafts / client looseJson） */
function extractJson(text: string): unknown {
	const cleaned = text
		.replace(/```(?:json|JSON)?\s*\n?/g, "")
		.replace(/```\s*$/g, "")
		.trim();
	const start = cleaned.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < cleaned.length; i += 1) {
		const ch = cleaned[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\") {
			if (inString) escaped = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") depth += 1;
		if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(cleaned.slice(start, i + 1).replace(/,\s*([}\]])/g, "$1"));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

export async function suggestMeta(input: { title: string; markdown: string }): Promise<JianshuMetaSuggestion> {
	const plain = markdownToPlain(input.markdown);
	const fallback: JianshuMetaSuggestion = {
		description: excerptText(plain, 100),
		category: "",
		tags: [],
		aiUsed: false,
	};
	const settings = await loadAiSettings();
	if (!settings.enable) return fallback;
	try {
		// 既有分类/标签进提示词，AI 优先复用，避免 taxonomy 膨胀
		const posts = await storage.listPosts();
		const cats = [...new Set(posts.map((p) => p.category).filter((c) => c !== ""))].slice(0, 40);
		const tagPool = [...new Set(posts.flatMap((p) => p.tags))].slice(0, 60);
		const result = await callAiChat(settings, {
			messages: [
				{ role: "system", content: SUGGEST_SYSTEM },
				{
					role: "user",
					content:
						`文章标题：${input.title === "" ? "（未提供，请一并拟定）" : input.title}\n\n` +
						`正文 Markdown：\n${input.markdown.slice(0, 8000)}\n\n` +
						`博客已有分类：${cats.length > 0 ? cats.join("、") : "无"}\n` +
						`常用标签：${tagPool.length > 0 ? tagPool.join("、") : "无"}\n\n` +
						"请为这篇文章补充元信息：\n" +
						"- title：仅当未提供标题时，拟定概括主题的中文标题，不超过 30 字\n" +
						"- description：60-100 字中文摘要，概括内容，不要重复标题\n" +
						"- category：一个贴切的中文分类名，优先从已有分类中选，都不合适才新建\n" +
						"- tags：3-6 个标签，优先复用常用标签\n",
				},
			],
			maxTokens: 1024,
			webSearch: false,
			model: fastModel(settings),
			noThink: true,
		});
		const r = suggestSchema.safeParse(extractJson(result.content));
		if (!r.success) return fallback;
		return {
			...(r.data.title ? { title: r.data.title } : {}),
			description: r.data.description,
			category: r.data.category,
			tags: r.data.tags,
			aiUsed: true,
		};
	} catch {
		return fallback;
	}
}
