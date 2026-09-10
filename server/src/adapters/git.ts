import { simpleGit, type SimpleGit, type StatusResult } from "simple-git";
import type { GitStatus, RemoteProbe, RepoTarget } from "@shirone-admin/shared";
import { ADMIN_DIR, CONTENT_DIR, THEME_DIR, themeConnected } from "../config.js";
import { ApiError } from "../lib/errors.js";

// 句柄按需重建：项目映射热切换（applyProjectPaths）后，下次调用即用新 baseDir
let contentHandle: SimpleGit | null = null;
let contentHandleDir = "";
let themeHandle: SimpleGit | null = null;
let themeHandleDir = "";

function contentGit(): SimpleGit {
	if (!contentHandle || contentHandleDir !== CONTENT_DIR) {
		contentHandle = simpleGit({ baseDir: CONTENT_DIR });
		contentHandleDir = CONTENT_DIR;
	}
	return contentHandle;
}

function themeGit(): SimpleGit {
	if (!themeHandle || themeHandleDir !== THEME_DIR) {
		themeHandle = simpleGit({ baseDir: THEME_DIR });
		themeHandleDir = THEME_DIR;
	}
	return themeHandle;
}

/** 取目标仓 git 句柄；主题仓未连接时抛 400 */
function repoGit(repo: RepoTarget) {
	if (repo === "theme" && !themeConnected()) throw new ApiError(400, "主题仓未连接，无法操作");
	return repo === "theme" ? themeGit() : contentGit();
}

/** simple-git StatusResult → 扁平化 GitStatus（两仓共用） */
function toGitStatus(s: StatusResult): GitStatus {
	const staged: string[] = [];
	const modified: string[] = [];
	const untracked: string[] = [];
	for (const f of s.files) {
		if (f.index === "?" && f.working_dir === "?") untracked.push(f.path);
		else if (f.index && f.index !== " ") staged.push(f.path);
		else if (f.working_dir && f.working_dir !== " ") modified.push(f.path);
	}
	return {
		branch: s.current ?? "",
		ahead: s.ahead ?? 0,
		behind: s.behind ?? 0,
		staged,
		modified,
		untracked,
	};
}

export async function gitStatus(): Promise<GitStatus> {
	return toGitStatus(await contentGit().status());
}

/** 主题仓全量状态（含变更文件列表）；未连接或非 git 仓时返回 null */
export async function themeGitStatus(): Promise<GitStatus | null> {
	if (!themeConnected()) return null;
	try {
		return toGitStatus(await themeGit().status());
	} catch {
		return null;
	}
}

/** 所有变更（含未跟踪）加入暂存并提交；没有变更时返回 null */
export async function commitAll(repo: RepoTarget, message: string): Promise<string | null> {
	const g = repoGit(repo);
	const s = toGitStatus(await g.status());
	if (s.staged.length + s.modified.length + s.untracked.length === 0) return null;
	await g.add(["-A", "."]);
	const r = await g.commit(message);
	return r.commit ?? null;
}

/** rebase 远端后 push（推分支跟踪的默认远端，主题仓绝不推 upstream）；失败抛出可读错误 */
export async function push(repo: RepoTarget, log: string[]): Promise<void> {
	const g = repoGit(repo);
	try {
		await g.pull(["--rebase", "--autostash"]);
		log.push("已 rebase 远端最新提交");
	} catch (e) {
		throw new ApiError(500, `rebase 失败（可能有并发推送或冲突）：${(e as Error).message}`);
	}
	try {
		await g.push();
		log.push("已推送到远端");
	} catch (e) {
		throw new ApiError(500, `push 失败：${(e as Error).message}`);
	}
}

export async function remoteConfigured(): Promise<boolean> {
	try {
		const remotes = await contentGit().getRemotes(true);
		return remotes.length > 0;
	} catch {
		return false;
	}
}

/** 内容仓最近提交（作者日期 ISO + subject），供 AI 提交信息/时间线起草作上下文 */
export async function recentCommits(limit = 12): Promise<Array<{ hash: string; date: string; subject: string }>> {
	const r = await contentGit().log({
		maxCount: limit,
		format: { hash: "%h", date: "%as", subject: "%s" },
	});
	return r.all.map((c) => ({
		hash: String(c.hash ?? ""),
		date: String(c.date ?? ""),
		subject: String(c.subject ?? ""),
	}));
}

/** 单仓提交 + 改动文件摘要（时间线 AI 起草上下文）：date 为作者日期 YYYY-MM-DD */
export interface CommitChange {
	date: string;
	hash: string;
	subject: string;
	/** 改动文件数与增删行数（二进制文件计文件数不计行数） */
	files: string[];
	additions: number;
	deletions: number;
}

const LOG_HEADER = /^([0-9a-f]{7,40})\|(\d{4}-\d{2}-\d{2})\|(.*)$/;
const NUMSTAT = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/** 每条提交最多列出的改动文件数（超出只记总数，防止依赖批量提交撑爆上下文） */
const MAX_FILES_PER_COMMIT = 6;

/** 解析 `git log --numstat --format=%h|%as|%s` 原始输出为紧凑摘要 */
function parseLogWithNumstat(out: string): CommitChange[] {
	const commits: CommitChange[] = [];
	let cur: CommitChange | null = null;
	for (const line of out.split("\n")) {
		const h = line.match(LOG_HEADER);
		if (h) {
			cur = { date: h[2], hash: h[1], subject: h[3].trim(), files: [], additions: 0, deletions: 0 };
			commits.push(cur);
			continue;
		}
		const n = line.match(NUMSTAT);
		if (n && cur) {
			if (cur.files.length < MAX_FILES_PER_COMMIT) cur.files.push(n[3].trim());
			if (n[1] !== "-") cur.additions += Number(n[1]);
			if (n[2] !== "-") cur.deletions += Number(n[2]);
		}
	}
	return commits;
}

async function commitChangesOf(g: SimpleGit, limit: number): Promise<CommitChange[]> {
	const out = await g.raw([
		"log",
		"-n",
		String(limit),
		"--numstat",
		"--no-merges",
		"--format=%h|%as|%s",
	]);
	return parseLogWithNumstat(out);
}

/**
 * 三仓（内容 / 主题 / Admin）最近提交与改动文件摘要，供时间线 AI 起草；
 * 主题、Admin 仓不可用时静默跳过，内容仓失败抛错。
 */
export async function recentChanges(
	limit = 30,
): Promise<Array<{ repo: string; commits: CommitChange[] }>> {
	const result: Array<{ repo: string; commits: CommitChange[] }> = [];
	result.push({ repo: "内容仓", commits: await commitChangesOf(contentGit(), limit) });
	for (const [name, dir] of [
		["主题仓", THEME_DIR],
		["Admin仓", ADMIN_DIR],
	] as const) {
		try {
			const commits = await commitChangesOf(simpleGit({ baseDir: dir }), limit);
			result.push({ repo: name, commits });
		} catch {
			// 非 git 仓或不可读：跳过，起草仍可用其余仓库
		}
	}
	return result;
}

/**
 * 轻量探测是否落后远端（git ls-remote 只问远端分支 tip 做哈希比对，不拉取任何代码/对象）：
 * - 远端 tip == 本地 HEAD → behind 0
 * - 远端 tip == 本地缓存的 origin/<branch> → 本地缓存的落后计数即精确值
 * - 两者都不等 → 远端已前进，确定落后但数量未知（需 fetch 才能数）
 */
export async function probeRemote(repo: RepoTarget): Promise<RemoteProbe> {
	const g = repoGit(repo);
	try {
		const s = await g.status();
		const branch = s.current;
		if (!branch) throw new ApiError(500, "无法确定当前分支");
		// ls-remote 首个参数是远端名（不是模式）：取分支配置的默认远端，兜底第一个远端
		const remote =
			(await g
				.getConfig(`branch.${branch}.remote`)
				.then((r) => (r?.value ?? "").trim(), () => "")) || (await g.getRemotes(false))[0]?.name;
		if (!remote) throw new ApiError(500, "未配置远端仓库");
		const out = await g.listRemote([remote, `refs/heads/${branch}`]);
		const tip = out
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.endsWith(`refs/heads/${branch}`))
			?.split("\t")[0];
		if (!tip) throw new ApiError(500, `远端没有分支 ${branch}`);
		if (tip === (await g.revparse(["HEAD"])).trim()) return { behind: 0 };
		const cached = await g.revparse([`origin/${branch}`]).then(
			(r) => r.trim(),
			() => "",
		);
		if (tip === cached) return { behind: s.behind ?? 0 };
		return { behind: null };
	} catch (e) {
		if (e instanceof ApiError) throw e;
		throw new ApiError(500, `探测远端失败：${(e as Error).message}`);
	}
}

/** 主题仓最近提交（发布页展示，兼作 AI 提交信息 few-shot 上下文）；主题仓未连接或非 git 仓时返回空 */
export async function themeRecentCommits(
	limit = 12,
): Promise<Array<{ hash: string; date: string; subject: string }>> {
	if (!themeConnected()) return [];
	try {
		const r = await themeGit().log({
			maxCount: limit,
			format: { hash: "%h", date: "%as", subject: "%s" },
		});
		return r.all.map((c) => ({
			hash: String(c.hash ?? ""),
			date: String(c.date ?? ""),
			subject: String(c.subject ?? ""),
		}));
	} catch {
		return [];
	}
}
