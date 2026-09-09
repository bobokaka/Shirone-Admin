import { z } from "zod";
import type { MusicSearchCandidate } from "@shirone-admin/shared";
import { callAiChat, loadAiSettings } from "./aiSettings.js";

/**
 * 音乐版权检索：AI 联网搜索（webSearch 工具，不支持的服务自动降级），
 * 返回候选 + 免费商用判定与依据链接，供人工确认后导入。
 */

const MUSIC_SEARCH_SYSTEM =
	"你是音乐版权检索助手。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏。" +
	"版权信息不确定时必须标注为需授权确认，绝不臆造免费商用结论；链接给真实可访问的页面。";

function buildMusicSearchPrompt(query: string): string {
	return (
		`检索音乐「${query}」的可商用版本，优先免版权来源（CC0 / CC BY / 公共领域 / DOVA-Syndrome / Pixabay / Free Music Archive 等）。\n` +
		`给出 3-5 个候选，每个候选字段：\n` +
		`- title：曲名；artist：作者/艺术家\n` +
		`- license.freeCommercial：布尔，是否可免费商用\n` +
		`- license.summary：一句话授权说明（如 CC BY 需署名、公共领域无限制）\n` +
		`- license.evidence：授权判定依据的链接（许可协议页/曲目页）；license.sourceUrl：曲目来源页\n` +
		`- audioUrl：可直接下载的音频文件直链（.mp3/.ogg 等），找不到填 null，不要填普通网页地址\n` +
		`- coverUrl：封面图直链，找不到填 null\n` +
		`只输出 JSON，形如 {"candidates":[…]}。`
	);
}

/** 宽松提取 AI 输出中的 JSON 对象（客户端 twin：client/src/utils/looseJson.ts） */
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

const candidateSchema = z.object({
	title: z.string().trim().min(1).max(200),
	artist: z.string().trim().max(200).optional().nullable(),
	license: z.object({
		freeCommercial: z.boolean(),
		summary: z.string().trim().min(1).max(500),
		evidence: z.string().trim().max(2000).optional().nullable(),
		sourceUrl: z.string().trim().max(2000).optional().nullable(),
	}),
	audioUrl: z.string().trim().max(2000).optional().nullable(),
	coverUrl: z.string().trim().max(2000).optional().nullable(),
});

function norm(v: string | null | undefined): string | undefined {
	const s = (v ?? "").trim();
	return s === "" ? undefined : s;
}

/** 折叠 AI 偶发的扁平化 license 键（"license.freeCommercial":… → license:{freeCommercial:…}） */
function foldLicenseKeys(item: unknown): unknown {
	if (typeof item !== "object" || item === null || "license" in item) return item;
	const folded: Record<string, unknown> = {};
	const license: Record<string, unknown> = {};
	let has = false;
	for (const [k, v] of Object.entries(item)) {
		if (k.startsWith("license.")) {
			license[k.slice("license.".length)] = v;
			has = true;
		} else {
			folded[k] = v;
		}
	}
	return has ? { ...folded, license } : item;
}

/** 逐项 zod 过滤 + 归一化（""/null → undefined）；不合规候选直接丢弃而非整体失败 */
export function parseMusicCandidates(content: string): MusicSearchCandidate[] {
	const raw = extractJson(content) as { candidates?: unknown } | null;
	const list = Array.isArray(raw?.candidates)
		? raw!.candidates
		: Array.isArray(raw)
			? raw
			: [];
	const out: MusicSearchCandidate[] = [];
	for (const item of list) {
		const r = candidateSchema.safeParse(foldLicenseKeys(item));
		if (!r.success) continue;
		out.push({
			title: r.data.title,
			artist: norm(r.data.artist),
			license: {
				freeCommercial: r.data.license.freeCommercial,
				summary: r.data.license.summary,
				evidence: norm(r.data.license.evidence),
				sourceUrl: norm(r.data.license.sourceUrl),
			},
			audioUrl: norm(r.data.audioUrl),
			coverUrl: norm(r.data.coverUrl),
		});
	}
	return out;
}

export async function searchMusicWithAi(
	query: string,
): Promise<{ candidates: MusicSearchCandidate[]; searchUsed: boolean }> {
	const settings = await loadAiSettings();
	const result = await callAiChat(settings, {
		messages: [
			{ role: "system", content: MUSIC_SEARCH_SYSTEM },
			{ role: "user", content: buildMusicSearchPrompt(query) },
		],
		maxTokens: 2048,
		webSearch: true,
		// 结构化检索不需要推理过程：关思考避免思考块占满 max_tokens 导致无正文
		noThink: true,
	});
	return { candidates: parseMusicCandidates(result.content), searchUsed: result.searchUsed !== false };
}
