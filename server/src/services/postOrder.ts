import fs from "node:fs/promises";
import path from "node:path";
import type { PostMeta } from "@shirone-admin/shared";
import { ADMIN_DATA_DIR } from "../config.js";

/**
 * 文章列表手动排序：管理端本地视图偏好，保存在 server/data/post-order.json
 * （Admin 仓自身数据目录，已 gitignore，绝不写入内容仓）——主题侧站点文章
 * 顺序仍由「置顶 + 发布时间」决定，不受此处影响。
 */

const ORDER_FILE = path.join(ADMIN_DATA_DIR, "post-order.json");

/** 读取保存的顺序（文章 path 列表）；文件缺失/损坏/格式不对一律回退空（默认序） */
export async function loadPostOrder(): Promise<string[]> {
	try {
		const raw = JSON.parse(await fs.readFile(ORDER_FILE, "utf8")) as unknown;
		if (!Array.isArray(raw)) return [];
		const out: string[] = [];
		for (const x of raw) {
			if (typeof x === "string" && x !== "" && !out.includes(x)) out.push(x);
		}
		return out;
	} catch {
		return [];
	}
}

export async function savePostOrder(order: string[]): Promise<void> {
	await fs.mkdir(ADMIN_DATA_DIR, { recursive: true });
	await fs.writeFile(ORDER_FILE, `${JSON.stringify(order, null, "\t")}\n`, "utf8");
}

/** 应用保存的顺序：未记录的文章（新建/从未拖动保存过）按默认序在前，
 *  已记录的按保存序在后；保存序里已不存在的 path 自动失效忽略 */
export function applySavedOrder(list: PostMeta[], order: string[]): PostMeta[] {
	if (order.length === 0) return list;
	const rank = new Map(order.map((p, i) => [p, i]));
	const known = list.filter((p) => rank.has(p.path));
	if (known.length === 0) return list;
	known.sort((a, b) => rank.get(a.path)! - rank.get(b.path)!);
	const knownPaths = new Set(known.map((p) => p.path));
	return [...list.filter((p) => !knownPaths.has(p.path)), ...known];
}
