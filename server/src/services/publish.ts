import type { GitStatus, PublishPreview, PublishResult, RepoPublishResult } from "@shirone-admin/shared";
import { themeConnected, themeDepsInstalled } from "../config.js";
import {
	commitAll,
	gitStatus,
	push,
	recentCommits,
	themeGitStatus,
	themeRecentCommits,
} from "../adapters/git.js";
import { runDryValidation } from "./validate.js";

const TYPE_RE = /^(feat|fix|test|docs|refactor|chore)\([\w-]+\): /;

export interface ChangeFile {
	path: string;
	state: "untracked" | "modified";
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** 依据变更文件自动生成 `type(scope): 描述`（≤30 字）；用户显式给了描述则规范化后采用 */
export function buildCommitMessage(files: ChangeFile[], userMessage?: string): string {
	if (userMessage && userMessage.trim()) {
		const raw = userMessage.trim();
		if (TYPE_RE.test(raw)) return raw;
		return `chore(content): ${truncate(raw, 30)}`;
	}
	const postSlugs = new Map<string, "untracked" | "modified">();
	let newMoments = 0;
	let updMoments = 0;
	let others = 0;
	for (const f of files) {
		if (f.path.startsWith("content/posts/")) {
			const seg = f.path.slice("content/posts/".length).split("/")[0];
			if (!seg) continue;
			// 未跟踪优先：同一 slug 下既有新文件又有修改按「新增」算
			if (f.state === "untracked" || !postSlugs.has(seg)) postSlugs.set(seg, f.state);
		} else if (f.path.startsWith("content/moments/") && f.path.endsWith(".md")) {
			if (f.state === "untracked") newMoments += 1;
			else updMoments += 1;
		} else {
			others += 1;
		}
	}
	const newPosts = [...postSlugs.values()].filter((s) => s === "untracked").length;
	const updPosts = postSlugs.size - newPosts;

	const parts: string[] = [];
	if (newPosts === 1) {
		const slug = [...postSlugs.entries()].find(([, s]) => s === "untracked")?.[0] ?? "";
		parts.push(`新增文章「${truncate(slug, 12)}」`);
	} else if (newPosts > 1) {
		parts.push(`新增 ${newPosts} 篇文章`);
	}
	if (updPosts > 0) parts.push(newPosts > 0 ? "更新文章" : updPosts === 1 ? "更新文章" : `更新 ${updPosts} 篇文章`);
	if (newMoments > 0) parts.push(parts.length ? "更新动态" : "发布动态");
	else if (updMoments > 0) parts.push(parts.length ? "更新动态" : "更新动态");
	if (parts.length === 0 && others > 0) parts.push("同步内容文件");

	const desc = truncate(parts.join("，"), 30);
	const onlyMoments = newPosts + updPosts === 0 && newMoments + updMoments > 0;
	const onlyUpdates = newPosts === 0 && newMoments === 0;
	const type = onlyMoments ? "moments" : "content";
	const verb = onlyUpdates ? "fix" : "feat";
	return `${verb}(${type}): ${desc}`;
}

/** 主题仓路径 → 提交信息桶（type/scope/描述），按声明顺序首个前缀命中生效 */
const THEME_BUCKETS: Array<{ prefixes: string[]; message: string }> = [
	{ prefixes: ["src/content/"], message: "chore(content): 同步内容产物" },
	{ prefixes: ["public/", "src/assets/"], message: "chore(assets): 同步资源文件" },
	{ prefixes: ["scripts/"], message: "chore(cli): 更新脚本" },
	{ prefixes: [".github/"], message: "chore(ci): 更新工作流" },
	{ prefixes: ["docs/", "README.md"], message: "docs(docs): 更新文档" },
	{ prefixes: ["src/"], message: "chore(core): 更新主题源码" },
];

/** 主题仓提交信息：用户描述无前缀时包 chore(core)；自动按路径归类，scope 词汇开放 */
export function buildThemeCommitMessage(files: ChangeFile[], userMessage?: string): string {
	if (userMessage && userMessage.trim()) {
		const raw = userMessage.trim();
		if (TYPE_RE.test(raw)) return raw;
		return `chore(core): ${truncate(raw, 30)}`;
	}
	if (files.length === 0) return "";
	const hits = new Set<string>();
	for (const f of files) {
		const bucket = THEME_BUCKETS.find((b) => b.prefixes.some((p) => f.path.startsWith(p)));
		hits.add(bucket?.message ?? "chore(config): 更新配置");
	}
	if (hits.size === 1) return truncate([...hits][0], 30 + "chore(config): ".length);
	return truncate(`chore(core): 同步主题仓变更（${files.length} 个文件）`, 30 + "chore(core): ".length);
}

function toChangeFiles(s: GitStatus): ChangeFile[] {
	return [
		...s.staged.map((path) => ({ path, state: "modified" as const })),
		...s.modified.map((path) => ({ path, state: "modified" as const })),
		...s.untracked.map((path) => ({ path, state: "untracked" as const })),
	];
}

async function changes(): Promise<ChangeFile[]> {
	return toChangeFiles(await gitStatus());
}

/** 主题仓待提交变更；未连接或非 git 仓时为空 */
async function themeChanges(): Promise<ChangeFile[]> {
	const s = await themeGitStatus();
	return s ? toChangeFiles(s) : [];
}

/** 供 AI 提交信息生成复用 */
export { changes, themeChanges };

/** 内容仓发布：本地校验 → 提交 → 推送；校验/环境错误与 git 失败均收敛为结构化结果 */
async function publishContent(userMessage?: string): Promise<RepoPublishResult> {
	const log: string[] = [];
	const files = await changes();
	if (files.length === 0) {
		return { ok: true, hadChanges: false, pushed: false, log: ["没有可提交的变更"] };
	}
	const message = buildCommitMessage(files, userMessage);
	log.push(`提交信息：${message}`);

	const validation = await runDryValidation();
	if (!validation.ok) {
		log.push("本地校验未通过，已阻止提交");
		return { ok: false, hadChanges: true, pushed: false, validationOutput: validation.output, log };
	}
	log.push("本地校验通过（sync --dry-run）");

	try {
		const hash = await commitAll("content", message);
		if (!hash) {
			return { ok: true, hadChanges: false, pushed: false, log: [...log, "没有可提交的变更"] };
		}
		log.push(`已提交 ${hash.slice(0, 8)}`);
		await push("content", log);
	} catch (e) {
		return { ok: false, hadChanges: true, pushed: false, log: [...log, (e as Error).message] };
	}
	return { ok: true, hadChanges: true, pushed: true, log };
}

/** 主题仓发布：不跑本地校验（其自身 CI 把关），直接提交 → 推送 */
async function publishTheme(userMessage?: string): Promise<RepoPublishResult> {
	if (!themeConnected()) {
		return { ok: true, hadChanges: false, pushed: false, log: ["主题仓未连接，已跳过"] };
	}
	const log: string[] = [];
	const files = await themeChanges();
	if (files.length === 0) {
		return { ok: true, hadChanges: false, pushed: false, log: ["主题仓没有可提交的变更"] };
	}
	const message = buildThemeCommitMessage(files, userMessage);
	log.push(`提交信息：${message}`);

	try {
		const hash = await commitAll("theme", message);
		if (!hash) {
			return { ok: true, hadChanges: false, pushed: false, log: [...log, "没有可提交的变更"] };
		}
		log.push(`已提交 ${hash.slice(0, 8)}`);
		await push("theme", log);
	} catch (e) {
		return { ok: false, hadChanges: true, pushed: false, log: [...log, (e as Error).message] };
	}
	return { ok: true, hadChanges: true, pushed: true, log };
}

/** 一键发布：先内容仓后主题仓，两仓互不阻断 */
export async function publish(input: { contentMessage?: string; themeMessage?: string }): Promise<PublishResult> {
	const content = await publishContent(input.contentMessage);
	const theme = await publishTheme(input.themeMessage);
	return { content, theme, ok: content.ok && theme.ok };
}

export async function publishPreview(): Promise<PublishPreview> {
	const s = await gitStatus();
	const files = toChangeFiles(s);
	const themeS = await themeGitStatus();
	const themeFiles = themeS ? toChangeFiles(themeS) : [];
	return {
		branch: s.branch,
		ahead: s.ahead,
		behind: s.behind,
		files: files.map((f) => f.path),
		changes: files.map((f) => ({ path: f.path, state: f.state === "untracked" ? "new" : "modified" })),
		message: buildCommitMessage(files),
		themeFiles: themeFiles.map((f) => f.path),
		themeChanges: themeFiles.map((f) => ({
			path: f.path,
			state: f.state === "untracked" ? "new" : "modified",
		})),
		themeMessage: themeFiles.length > 0 ? buildThemeCommitMessage(themeFiles) : "",
		themeDepsInstalled: themeDepsInstalled(),
		recent: await recentCommits(20),
		themeRecent: await themeRecentCommits(20),
		themeStatus: themeS,
	};
}
