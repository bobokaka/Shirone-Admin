import type { RepoTarget } from "@shirone-admin/shared";
import { recentCommits, themeRecentCommits } from "../adapters/git.js";
import { callAiChat, fastModel, loadAiSettings } from "./aiSettings.js";
import { buildCommitMessage, buildThemeCommitMessage, changes, themeChanges } from "./publish.js";

/**
 * AI 提交信息生成：当前变更 + 近期提交风格 few-shot → 轻量模型一行输出。
 * 双保险：输出必须过 TYPE_RE 且描述 ≤30 字，否则（含 AI 调用失败）回退既有启发式，
 * 发布流程永不因 AI 失败而挂。
 */

const COMMIT_SYSTEM =
	"你是 git 提交信息生成器。只输出一行提交信息，格式 type(scope): 中文描述，不要任何解释、引号或尾注。" +
	"type 只能取 feat|fix|test|docs|refactor|chore；scope 只能取 content|moments|posts|data|config|assets；" +
	"中文描述不超过 30 字，概括本次主要变更（新文章给标题关键词，多类变更挑最重要的）。";

/** 主题仓 scope 词汇开放（core/i18n/content/cli/npm/banner/…），交由 AI 参照其历史风格选取 */
const THEME_COMMIT_SYSTEM =
	"你是 git 提交信息生成器。只输出一行提交信息，格式 type(scope): 中文描述，不要任何解释、引号或尾注。" +
	"type 只能取 feat|fix|test|docs|refactor|chore；scope 用一个简短英文小写单词概括改动模块，" +
	"参照仓库近期提交风格选取（如 core、content、i18n、config、build、cli、docs、assets、markdown、footer、banner，不限于示例）；" +
	"中文描述不超过 30 字，概括本次主要变更。";

/** 变更文件列表送入提示词的行数上限，超出折叠 */
const FILE_LIST_CAP = 80;

export interface CommitMessageResult {
	message: string;
	source: "ai" | "heuristic";
}

/** 校验 AI 输出：剥围栏取首个非空行 → 严格 TYPE_RE + 描述 ≤30 字 */
function sanitizeAiMessage(raw: string): string | null {
	const line =
		raw
			.replace(/```[a-z]*\s*/gi, "")
			.split(/\r?\n/)
			.map((l) => l.trim().replace(/^["“]|["”]$/g, ""))
			.find((l) => l !== "") ?? "";
	if (line === "") return null;
	const m = line.match(/^(feat|fix|test|docs|refactor|chore)\([\w-]+\): (.+)$/);
	if (!m || m[2].length > 30) return null;
	return line;
}

export async function generateCommitMessage(repo: RepoTarget = "content"): Promise<CommitMessageResult> {
	const files = repo === "theme" ? await themeChanges() : await changes();
	const heuristic = () => buildCommitMessage(files);
	const themeHeuristic = () => buildThemeCommitMessage(files);
	if (files.length === 0) {
		return { message: repo === "theme" ? themeHeuristic() : heuristic(), source: "heuristic" };
	}
	const settings = await loadAiSettings();

	const shown = files.slice(0, FILE_LIST_CAP);
	const fileList = [
		...shown.map((f) => `${f.state === "untracked" ? "新增" : "修改"} ${f.path}`),
		...(files.length > FILE_LIST_CAP ? [`…其余 ${files.length - FILE_LIST_CAP} 个文件`] : []),
	].join("\n");
	const history =
		repo === "theme" ? await themeRecentCommits(12).catch(() => []) : await recentCommits(12).catch(() => []);
	const historyList = history.map((c) => `${c.date.slice(0, 10)} ${c.subject}`).join("\n");

	try {
		const result = await callAiChat(settings, {
			messages: [
				{ role: "system", content: repo === "theme" ? THEME_COMMIT_SYSTEM : COMMIT_SYSTEM },
				{
					role: "user",
					content: `本次变更文件：\n${fileList}\n\n仓库近期提交风格参考：\n${historyList || "（无）"}\n\n请生成一行提交信息。`,
				},
			],
			maxTokens: 120,
			temperature: 0.3,
			webSearch: false,
			model: fastModel(settings),
			noThink: true,
		});
		const sanitized = sanitizeAiMessage(result.content);
		if (sanitized) return { message: sanitized, source: "ai" };
	} catch {
		// AI 失败不阻断发布链路：静默回退启发式
	}
	return { message: repo === "theme" ? themeHeuristic() : heuristic(), source: "heuristic" };
}
