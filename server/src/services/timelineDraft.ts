import { z } from "zod";
import { recentChanges, type CommitChange } from "../adapters/git.js";
import { callAiChat, fastModel, loadAiSettings } from "./aiSettings.js";

/**
 * 时间线事件 AI 起草：git 模式扫描三仓（内容 / 主题 / Admin）提交历史与改动文件总结里程碑，
 * note 模式按用户一句话描述起草。输出 strict JSON 后逐项 zod 过滤 + date/category 归一，
 * 解析失败返回空数组交前端提示。
 */

export interface TimelineDraftItem {
	title: string;
	/** YYYY-MM-DD 日精度；AI 推断不出时为空串，由用户在编辑弹窗手填 */
	date: string;
	category: "milestone" | "project" | "career" | "life";
	subtitle?: string;
	description?: string;
	highlights: string[];
	tags: string[];
}

export interface TimelineDraftInput {
	/** git：扫描三仓提交历史；note：按用户描述起草 */
	mode: "note" | "git";
	note?: string;
	limit?: number;
	/** 已收录的时间线事件（标题 + 日期），git 模式用于去重：已存在的不再推荐 */
	existing?: Array<{ title: string; date: string }>;
}

const DRAFT_SYSTEM =
	"你是博客时间线事件起草助手。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏。" +
	"时间线分类固定四种：milestone（里程碑）、project（项目）、career（经历）、life（生活）。" +
	"文字务必精简，像时间轴刻度一样短。";

const draftSchema = z.object({
	title: z.string().trim().min(1).max(80),
	date: z.string().trim().max(10).optional().nullable(),
	category: z.enum(["milestone", "project", "career", "life"]),
	subtitle: z.string().trim().max(120).optional().nullable(),
	description: z.string().trim().max(1000).optional().nullable(),
	highlights: z.array(z.string().trim().min(1).max(120)).max(5).optional().nullable(),
	tags: z.array(z.string().trim().min(1).max(30)).max(5).optional().nullable(),
});

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

/** date 归一：仅保留月日合法的日精度 YYYY-MM-DD；其余（含月精度）降级空串，交用户在编辑弹窗选日 */
function normalizeDate(raw: string | null | undefined): string {
	const s = (raw ?? "").trim();
	const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (!m) return "";
	const month = Number(m[2]);
	const day = Number(m[3]);
	if (month < 1 || month > 12 || day < 1 || day > 31) return "";
	return s;
}

function norm(v: string | null | undefined): string | undefined {
	const s = (v ?? "").trim();
	return s === "" ? undefined : s;
}

/** 逐项过滤 + 归一：title 缺失、category 非法 → 丢弃该项；date 非日精度 → 空串保留 */
export function parseTimelineDrafts(content: string): TimelineDraftItem[] {
	const raw = extractJson(content) as { events?: unknown } | null;
	const list = Array.isArray(raw?.events) ? raw!.events : [];
	const out: TimelineDraftItem[] = [];
	for (const item of list) {
		const r = draftSchema.safeParse(item);
		if (!r.success) continue;
		out.push({
			title: r.data.title,
			date: normalizeDate(r.data.date),
			category: r.data.category,
			// 提示词已要求不输出 subtitle；AI 违规给了也丢弃，保证卡片短
			description: norm(r.data.description),
			highlights: r.data.highlights?.map((s) => s.trim()).filter(Boolean).slice(0, 3) ?? [],
			tags: r.data.tags?.map((s) => s.trim()).filter(Boolean).slice(0, 3) ?? [],
		});
	}
	return out;
}

/** 输出从严约束文字量：草稿卡片只求一眼可读，细节交给用户编辑补全 */
const FIELD_SPEC =
	"- title：简洁中文标题，不超过 12 字\n" +
	"- date：事件日期，格式 YYYY-MM-DD（精确到日）；必须取上下文中的真实日期，不得虚构，未知填空字符串\n" +
	"- category：milestone|project|career|life 之一\n" +
	"- description：一句话概括，不超过 40 字\n" +
	"- highlights：要点数组，最多 3 项，每项不超过 15 字\n" +
	"- tags：标签数组，最多 3 项，每项 2-6 字\n" +
	"不要输出 subtitle，宁缺毋滥、能省则省。\n" +
	"只输出 JSON，形如 {\"events\":[…]}。";

/** 三仓提交摘要 → 每行一条（日期 + 提交说明 + 改动量），新在前 */
function formatHistory(changes: Array<{ repo: string; commits: CommitChange[] }>): string {
	const lines: string[] = [];
	for (const { repo, commits } of changes) {
		for (const c of commits) {
			lines.push(`[${repo}] ${c.date} ${c.hash} ${c.subject}（+${c.additions} -${c.deletions}：${c.files.join("、")}）`);
		}
	}
	return lines.join("\n");
}

/* ---------- 与已有时间线去重（AI 提示词之外的最后防线） ---------- */

/** 标题归一：去空白与标点、小写，仅用于比对 */
function normTitle(t: string): string {
	return t.toLowerCase().replace(/[\s\p{P}]+/gu, "");
}

/** 日期取年月（已有条目多为 2026.03 月精度，草稿为日精度，按月对齐比对） */
function monthOf(date: string): string {
	return date.match(/^(\d{4})[-./](\d{2})/)?.slice(1).join("-") ?? "";
}

/** 同月且主题相同（相等或一方包含另一方）→ 视为重复；草稿缺日期时仅凭标题判定 */
function isDuplicate(draft: TimelineDraftItem, existing: Array<{ title: string; date: string }>): boolean {
	const dt = normTitle(draft.title);
	if (dt === "") return false;
	const dm = monthOf(draft.date);
	for (const e of existing) {
		const et = normTitle(e.title);
		if (et === "") continue;
		const titleDup = dt === et || (et.length >= 4 && dt.includes(et)) || (dt.length >= 4 && et.includes(dt));
		if (!titleDup) continue;
		if (dm === "" || dm === monthOf(e.date)) return true;
	}
	return false;
}

export async function draftTimeline(
	input: TimelineDraftInput,
): Promise<{ events: TimelineDraftItem[]; duplicated: number }> {
	const limit = input.limit ?? (input.mode === "note" ? 1 : 3);
	const settings = await loadAiSettings();

	let prompt: string;
	if (input.mode === "git") {
		const changes = await recentChanges(30);
		const history = formatHistory(changes);
		if (history === "") return { events: [], duplicated: 0 };
		const existingLines = (input.existing ?? [])
			.filter((e) => e.title.trim() !== "")
			.map((e) => `${e.date || "日期未知"} ${e.title}`)
			.join("\n");
		prompt =
			`以下是博客三个 git 仓库最近的提交记录（含改动文件与增删行数）：\n${history}\n\n` +
			(existingLines !== "" ? `时间线已收录以下事件，重复的不要推荐：\n${existingLines}\n\n` : "") +
			`从中识别最多 ${limit} 个有里程碑意义的节点（如新文章系列、重要功能落地、站点结构变化），` +
			`把相关零散提交合并为一个事件，date 取相关提交的日期；已收录或无新意的事件宁可不输出。\n` +
			FIELD_SPEC;
	} else {
		prompt =
			`用户描述了一个事件：${input.note ?? ""}\n\n据此起草 1 条时间线事件，忠实于描述不虚构细节。\n` +
			FIELD_SPEC;
	}

	const result = await callAiChat(settings, {
		messages: [
			{ role: "system", content: DRAFT_SYSTEM },
			{ role: "user", content: prompt },
		],
		maxTokens: 2048,
		webSearch: false,
		model: fastModel(settings),
		noThink: true,
	});
	const drafts = parseTimelineDrafts(result.content);
	if (input.mode === "git" && (input.existing?.length ?? 0) > 0) {
		const kept = drafts.filter((d) => !isDuplicate(d, input.existing!));
		return { events: kept.slice(0, limit), duplicated: drafts.length - kept.length };
	}
	return { events: drafts.slice(0, limit), duplicated: 0 };
}
