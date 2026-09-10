import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DirCandidate, DirDetectResult } from "@shirone-admin/shared";
import { ADMIN_DIR, CONTENT_DIR, THEME_DIR, WORKSPACE_ROOT } from "../config.js";
import { activeProvider, aiReady, callAiChat, fastModel, loadAiSettings } from "./aiSettings.js";

/**
 * 项目目录探测：先特征文件启发式扫描（BFS、有预算），AI 可用时交由 LLM
 * 结合路径语义裁决排序；AI 未配置/未启用/失败一律回退纯启发式，绝不抛错。
 */

const MAX_VISIT = 6000;
const MAX_MS = 4000;
const PER_KIND = 5;

/** 不深入的系统/依赖目录（小写匹配） */
const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".pnpm-store",
	".cache",
	".gradle",
	".m2",
	".idea",
	".vscode",
	".venv",
	"venv",
	"__pycache__",
	"site-packages",
	"bower_components",
	"target",
	"dist",
	"appdata",
	"application data",
	"$recycle.bin",
	"system volume information",
	"windows",
	"program files",
	"program files (x86)",
	"programdata",
	"package cache",
	"documents and settings",
]);

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function isFile(p: string): boolean {
	try {
		return statSync(p).isFile();
	} catch {
		return false;
	}
}

function dirKey(p: string): string {
	return path.resolve(p).toLowerCase();
}

const ASTRO_CONFIGS = ["astro.config.mjs", "astro.config.ts", "astro.config.js", "astro.config.mts"];

/** 内容仓特征命中清单（双命中 = 完整签名） */
function contentHits(p: string): string[] {
	const hits: string[] = [];
	if (isDir(path.join(p, "content", "posts"))) hits.push("content/posts");
	if (isFile(path.join(p, "config", "site.yaml"))) hits.push("config/site.yaml");
	return hits;
}

/** 主题仓特征命中清单（双命中 = 完整签名） */
function themeHits(p: string): string[] {
	const hits: string[] = [];
	if (ASTRO_CONFIGS.some((f) => isFile(path.join(p, f)))) hits.push("astro.config.*");
	if (isFile(path.join(p, "scripts", "content", "sync.mjs"))) hits.push("scripts/content/sync.mjs");
	return hits;
}

/** 完整签名判定（项目映射保存时的软校验共用） */
export function hasFullSignature(p: string, kind: "content" | "theme"): boolean {
	return (kind === "content" ? contentHits(p) : themeHits(p)).length === 2;
}

interface ScanOutput {
	content: DirCandidate[];
	theme: DirCandidate[];
	visited: number;
}

/** 特征评分：命中任一特征即入围，双特征高置信 */
function scoreDir(p: string, content: DirCandidate[], theme: DirCandidate[]): void {
	if (dirKey(p) === dirKey(ADMIN_DIR)) return;
	const base = path.basename(p).toLowerCase();
	const hasGit = isDir(path.join(p, ".git"));

	const cHits = contentHits(p);
	if (cHits.length > 0) {
		let confidence = cHits.length === 2 ? 0.9 : 0.55;
		if (base.includes("content")) confidence += 0.1;
		if (hasGit) confidence += 0.05;
		content.push({ path: p, confidence, reason: `命中 ${cHits.join("、")}`, source: "heuristic" });
	}

	const tHits = themeHits(p);
	if (tHits.length > 0) {
		let confidence = tHits.length === 2 ? 0.9 : 0.55;
		if (base === "shirone") confidence += 0.1;
		if (hasGit) confidence += 0.05;
		theme.push({ path: p, confidence, reason: `命中 ${tHits.join("、")}`, source: "heuristic" });
	}
}

/** BFS 扫描：根带各自深度预算，深层根先进队（visited 竞争时深预算优先） */
async function scanCandidates(): Promise<ScanOutput> {
	const home = os.homedir();
	const roots: Array<{ dir: string; remaining: number }> = [];
	const seenRoots = new Set<string>();
	for (const [dir, remaining] of [
		[WORKSPACE_ROOT, 3],
		[home, 3],
		[path.dirname(WORKSPACE_ROOT), 2],
		[path.parse(WORKSPACE_ROOT).root, 2],
		[path.dirname(home), 2],
		[path.parse(home).root, 2],
	] as Array<[string, number]>) {
		const key = dirKey(dir);
		if (seenRoots.has(key)) continue;
		seenRoots.add(key);
		roots.push({ dir: path.resolve(dir), remaining });
	}

	const start = Date.now();
	const visitedDirs = new Set<string>(roots.map((r) => dirKey(r.dir)));
	const content: DirCandidate[] = [];
	const theme: DirCandidate[] = [];
	let visited = 0;
	let frontier = [...roots];

	while (frontier.length > 0) {
		if (visited >= MAX_VISIT || Date.now() - start > MAX_MS) break;
		const entries = await Promise.all(
			frontier.map(({ dir, remaining }) =>
				readdir(dir, { withFileTypes: true })
					.catch(() => null)
					.then((children) => ({ dir, remaining, children })),
			),
		);
		const next: typeof frontier = [];
		for (const { dir, remaining, children } of entries) {
			if (children === null) continue;
			visited += 1;
			scoreDir(dir, content, theme);
			if (remaining <= 0) continue;
			for (const child of children) {
				if (!child.isDirectory() || SKIP_DIRS.has(child.name.toLowerCase())) continue;
				const childPath = path.join(dir, child.name);
				const key = dirKey(childPath);
				if (visitedDirs.has(key)) continue;
				visitedDirs.add(key);
				next.push({ dir: childPath, remaining: remaining - 1 });
			}
		}
		frontier = next;
	}
	return { content, theme, visited };
}

/** 宽松提取 AI 输出中的 JSON 对象（同款实现：services/musicSearch.ts） */
function extractJson(text: string): unknown {
	const cleaned = text.replace(/```(?:json|JSON)?\s*\n?/g, "").replace(/```\s*$/g, "").trim();
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

const aiCandidateSchema = z.object({
	path: z.string().trim().min(1).max(300),
	confidence: z.number().optional(),
	reason: z.string().trim().max(120).optional(),
});
const aiAnswerSchema = z.object({
	content: z.array(aiCandidateSchema).max(6).optional(),
	theme: z.array(aiCandidateSchema).max(6).optional(),
});

const DETECT_SYSTEM =
	"你是开发环境路径识别助手。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏。" +
	"路径必须是本机真实存在的绝对路径。";

function formatCandidates(label: string, list: DirCandidate[]): string {
	if (list.length === 0) return `${label}：无`;
	return `${label}：\n${list
		.map((c) => `- ${c.path}（${c.confidence.toFixed(2)}：${c.reason}）`)
		.join("\n")}`;
}

function buildDetectPrompt(scan: ScanOutput): string {
	const top = (list: DirCandidate[]) =>
		[...list].sort((a, b) => b.confidence - a.confidence).slice(0, PER_KIND);
	return (
		"在本机定位两个 git 仓库的根目录：\n" +
		"- 内容仓：含 content/posts/ 目录与 config/site.yaml\n" +
		"- 主题仓（Astro 博客主题）：含 astro.config.* 与 scripts/content/sync.mjs\n\n" +
		"启发式扫描候选（按置信度降序）：\n" +
		`${formatCandidates("内容仓候选", top(scan.content))}\n` +
		`${formatCandidates("主题仓候选", top(scan.theme))}\n\n` +
		`当前配置：CONTENT_DIR=${CONTENT_DIR}，THEME_DIR=${THEME_DIR}\n` +
		`工作区根：${WORKSPACE_ROOT}；用户主目录：${os.homedir()}\n\n` +
		"综合目录名语义与层级关系裁决排序，也可给出候选之外你认为更优的路径。\n" +
		'输出 JSON：{"content":[{"path":"…","confidence":0.95,"reason":"不超过20字"}],"theme":[…]}\n' +
		"每类最多 3 项，confidence 取 0-1。只输出 JSON。"
	);
}

/** AI 候选逐项把关：绝对路径 + 真实目录，置信度收敛到 0-1 */
function validAiCandidates(
	raw: z.infer<typeof aiCandidateSchema>[] | undefined,
): DirCandidate[] {
	if (!raw) return [];
	const out: DirCandidate[] = [];
	for (const item of raw) {
		const resolved = path.resolve(item.path.trim());
		if (!path.isAbsolute(resolved) || !existsSync(resolved) || !isDir(resolved)) continue;
		out.push({
			path: resolved,
			confidence: Math.min(1, Math.max(0, item.confidence ?? 0.5)),
			reason: (item.reason ?? "AI 裁决").slice(0, 40),
			source: "ai",
		});
	}
	return out;
}

/** AI 列表在前 + 去重后的启发式列表在后 */
function mergeCandidates(ai: DirCandidate[], heuristic: DirCandidate[]): DirCandidate[] {
	const seen = new Set(ai.map((c) => dirKey(c.path)));
	const merged = [...ai];
	for (const c of heuristic) {
		if (!seen.has(dirKey(c.path))) merged.push(c);
	}
	return merged.slice(0, PER_KIND);
}

export async function detectProjectDirs(): Promise<DirDetectResult> {
	const start = Date.now();
	const scan = await scanCandidates();
	const result: DirDetectResult = {
		contentCandidates: [...scan.content].sort((a, b) => b.confidence - a.confidence).slice(0, PER_KIND),
		themeCandidates: [...scan.theme].sort((a, b) => b.confidence - a.confidence).slice(0, PER_KIND),
		aiUsed: false,
		scannedDirs: scan.visited,
		elapsedMs: 0,
	};

	const settings = await loadAiSettings();
	if (settings.enable && aiReady(settings)) {
		try {
			const answer = await callAiChat(settings, {
				messages: [
					{ role: "system", content: DETECT_SYSTEM },
					{ role: "user", content: buildDetectPrompt(scan) },
				],
				maxTokens: 900,
				model: fastModel(settings),
				noThink: true,
				webSearch: false,
				timeoutSeconds: Math.min(activeProvider(settings).timeoutSeconds, 45),
			});
			const parsed = aiAnswerSchema.safeParse(extractJson(answer.content));
			if (!parsed.success) throw new Error("AI 应答不是有效 JSON");
			const aiContent = validAiCandidates(parsed.data.content);
			const aiTheme = validAiCandidates(parsed.data.theme);
			if (aiContent.length === 0 && aiTheme.length === 0) {
				result.aiError = "AI 未给出有效候选，已回退扫描结果";
			} else {
				result.aiUsed = true;
				result.contentCandidates = mergeCandidates(aiContent, result.contentCandidates);
				result.themeCandidates = mergeCandidates(aiTheme, result.themeCandidates);
			}
		} catch (e) {
			result.aiError = `AI 裁决失败：${(e as Error).message}`.slice(0, 200);
		}
	}

	result.elapsedMs = Date.now() - start;
	return result;
}
