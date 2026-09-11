import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import type { NavBarLink } from "@shirone-admin/shared";
import { CONFIG_DIR } from "../config.js";
import { patchYaml } from "./yamlPatch.js";

/**
 * nav-bar.yaml 中「文章快照链接」的引用同步：文章改名 / 换 permalink / 删除时，
 * 把拖入导航生成的 { name, url } 副本改写为最新值。导航名仅在仍等于旧标题快照时跟随，
 * 用户自定义名不动；任何失败静默跳过——导航同步不阻断文章保存。
 */

/** 调用时现算：项目映射热切换后跟随新 CONFIG_DIR */
function navbarPath(): string {
	return path.join(CONFIG_DIR, "nav-bar.yaml");
}

/** 文章可能的导航 url（permalink 优先，退回默认 /posts/<slug>/，与拖拽生成规则一致） */
function postUrls(slug: string, permalink?: string): string[] {
	return permalink ? [permalink, `/posts/${slug}/`] : [`/posts/${slug}/`];
}

async function readNavbarLinks(): Promise<NavBarLink[] | null> {
	const raw = await fs.readFile(navbarPath(), "utf8").catch(() => null);
	if (raw === null) return null;
	try {
		const links = (YAML.parse(raw) ?? {}).links;
		return Array.isArray(links) ? (links as NavBarLink[]) : null;
	} catch {
		return null;
	}
}

export async function syncNavbarPostLinks(input: {
	slug: string;
	oldTitle: string;
	newTitle: string;
	oldPermalink?: string;
	newPermalink?: string;
}): Promise<void> {
	try {
		const links = await readNavbarLinks();
		if (!links) return;
		const oldUrls = new Set(postUrls(input.slug, input.oldPermalink));
		const newUrl = input.newPermalink ?? `/posts/${input.slug}/`;
		let changed = false;
		const walk = (list: NavBarLink[]): void => {
			for (const item of list) {
				if (item.children) walk(item.children);
				if (typeof item.url !== "string" || !oldUrls.has(item.url)) continue;
				if (item.url !== newUrl) {
					item.url = newUrl;
					changed = true;
				}
				if (input.oldTitle !== input.newTitle && item.name === input.oldTitle) {
					item.name = input.newTitle;
					changed = true;
				}
			}
		};
		walk(links);
		if (changed) await patchYaml(navbarPath(), [{ path: ["links"], value: links }]);
	} catch {
		// 配置文件异常时放弃同步，不影响文章保存结果
	}
}

export async function removeNavbarPostLinks(slug: string, permalink?: string): Promise<void> {
	try {
		const links = await readNavbarLinks();
		if (!links) return;
		const urls = new Set(postUrls(slug, permalink));
		let changed = false;
		const prune = (list: NavBarLink[]): NavBarLink[] => {
			const out: NavBarLink[] = [];
			for (const item of list) {
				if (item.children) item.children = prune(item.children);
				if (typeof item.url === "string" && urls.has(item.url)) {
					changed = true;
					continue;
				}
				out.push(item);
			}
			return out;
		};
		const next = prune(links);
		if (changed) await patchYaml(navbarPath(), [{ path: ["links"], value: next }]);
	} catch {
		// 同上：删除文章是主操作，导航清理失败不回滚
	}
}
