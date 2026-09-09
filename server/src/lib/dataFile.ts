import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DataItem, DataKind } from "@shirone-admin/shared";
import { DATA_DIR } from "../config.js";
import { ApiError } from "./errors.js";

/**
 * data/*.ts 的读写。
 *
 * 读：动态 import（tsx 进程内自带转译；URL 加 mtime query 绕过 ESM 缓存）。
 * 写：不做整文件模板重写，而是定位 `export const <name>` 后的数组字面量区间，
 * 只替换该区间——interface 定义、注释、文件尾辅助函数全部原样保留，
 * 主题升级改动这些非数据部分也不会产生冲突。
 */

interface DataKindConfig {
	file: string;
	exportName: string;
	enums: Record<string, string[]>;
}

export const DATA_KINDS: Record<DataKind, DataKindConfig> = {
	projects: {
		file: "projects.ts",
		exportName: "projectsData",
		enums: { phase: ["shipped", "building", "exploring"] },
	},
	skills: {
		file: "skills.ts",
		exportName: "skillsData",
		enums: { level: ["beginner", "intermediate", "advanced", "expert"] },
	},
	timeline: { file: "timeline.ts", exportName: "timelineData", enums: {} },
	devices: {
		file: "devices.ts",
		exportName: "devicesData",
		enums: { status: ["active", "backup", "archived", "wishlist"] },
	},
	anime: {
		file: "anime.ts",
		exportName: "animeData",
		enums: { status: ["watching", "completed", "planned", "onHold", "dropped"] },
	},
	compass: { file: "compass.ts", exportName: "compassData", enums: {} },
	music: { file: "music.ts", exportName: "musicTracks", enums: {} },
	friends: { file: "friends.ts", exportName: "friendsData", enums: {} },
};

export async function readDataFile(kind: DataKind): Promise<DataItem[]> {
	const cfg = DATA_KINDS[kind];
	const abs = path.join(DATA_DIR, cfg.file);
	const st = await fs.stat(abs).catch(() => {
		throw new ApiError(404, `数据文件不存在：data/${cfg.file}`);
	});
	const mod = (await import(`${pathToFileURL(abs).href}?t=${st.mtimeMs}`)) as Record<
		string,
		unknown
	>;
	const raw = mod[cfg.exportName];
	if (!Array.isArray(raw)) {
		throw new ApiError(500, `data/${cfg.file} 未导出数组 ${cfg.exportName}`);
	}
	return raw.map((item) => ({ ...(item as DataItem) }));
}

/** 校验枚举字段（拼写/越界在保存前拦截，主题 tsc 是最终兜底） */
function validateItems(kind: DataKind, items: DataItem[]): void {
	const cfg = DATA_KINDS[kind];
	for (const [index, item] of items.entries()) {
		for (const [key, allowed] of Object.entries(cfg.enums)) {
			const v = item[key];
			if (v !== undefined && !allowed.includes(String(v))) {
				throw new ApiError(
					400,
					`第 ${index + 1} 条的 ${key} 必须是 ${allowed.join(" / ")} 之一，当前为「${String(v)}」`,
				);
			}
		}
	}
}

/* ---------- TS 数组字面量渲染（Tab 缩进，贴近内容仓既有风格）---------- */

function tsKey(k: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
}

function dumpTsValue(v: unknown, depth: number): string {
	const indent = "\t".repeat(depth);
	if (v === null || v === undefined) return "null";
	if (typeof v === "number" || typeof v === "boolean") return String(v);
	if (typeof v === "string") return JSON.stringify(v);
	if (Array.isArray(v)) {
		if (v.length === 0) return "[]";
		const allScalar = v.every((x) => typeof x === "string" || typeof x === "number");
		if (allScalar) return `[${v.map((x) => dumpTsValue(x, depth)).join(", ")}]`;
		return `[\n${v.map((x) => `${indent}\t${dumpTsValue(x, depth + 1)}`).join(",\n")},\n${indent}]`;
	}
	if (typeof v === "object") {
		const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
		if (entries.length === 0) return "{}";
		const allScalar = entries.every(([, x]) => x === null || ["number", "boolean", "string"].includes(typeof x));
		if (allScalar && entries.length <= 2) {
			return `{ ${entries.map(([k, x]) => `${tsKey(k)}: ${dumpTsValue(x, depth)}`).join(", ")} }`;
		}
		return `{\n${entries.map(([k, x]) => `${indent}\t${tsKey(k)}: ${dumpTsValue(x, depth + 1)}`).join(",\n")},\n${indent}}`;
	}
	return JSON.stringify(String(v));
}

/** 在源文本中找到 `[start, start)` 之后第一个未配平的 `]`（忽略字符串与注释） */
function matchBracket(text: string, openIdx: number): number {
	let depth = 0;
	let i = openIdx;
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === "/" && next === "/") {
			i = text.indexOf("\n", i);
			if (i < 0) break;
			continue;
		}
		if (c === "/" && next === "*") {
			i = text.indexOf("*/", i) + 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			i++;
			while (i < text.length && text[i] !== c) {
				if (text[i] === "\\") i++;
				i++;
			}
			i++;
			continue;
		}
		if (c === "[") depth++;
		if (c === "]") {
			depth--;
			if (depth === 0) return i;
		}
		i++;
	}
	return -1;
}

/** 跳过空白与注释，返回下一个有效字符下标 */
function skipTrivia(text: string, i: number): number {
	while (i < text.length) {
		const c = text[i];
		if (c === " " || c === "\t" || c === "\n" || c === "\r") {
			i++;
			continue;
		}
		if (c === "/" && text[i + 1] === "/") {
			const nl = text.indexOf("\n", i);
			if (nl < 0) return text.length;
			i = nl;
			continue;
		}
		if (c === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i);
			i = end < 0 ? text.length : end + 2;
			continue;
		}
		return i;
	}
	return i;
}

/** 定位 `= [` 的数组字面量起始（跳过类型注解里自己的 []） */
function findArrayStart(text: string, fromIdx: number): number {
	let i = skipTrivia(text, fromIdx);
	// 第一个独立 `=` 即赋值（这些数据文件类型注解里不含 =）
	while (i < text.length && text[i] !== "=") i++;
	if (i >= text.length) return -1;
	i = skipTrivia(text, i + 1);
	return text[i] === "[" ? i : -1;
}

/** 只替换导出数组字面量区间，文件其余部分（类型、注释、尾部函数）逐字保留 */
export async function writeDataFile(kind: DataKind, items: DataItem[]): Promise<boolean> {
	validateItems(kind, items);
	const cfg = DATA_KINDS[kind];
	const abs = path.join(DATA_DIR, cfg.file);
	const text = await fs.readFile(abs, "utf8").catch(() => {
		throw new ApiError(404, `数据文件不存在：data/${cfg.file}`);
	});

	const marker = `export const ${cfg.exportName}`;
	const assignIdx = text.indexOf(marker);
	if (assignIdx < 0) {
		throw new ApiError(500, `data/${cfg.file} 中找不到「${marker}」`);
	}
	const openIdx = findArrayStart(text, assignIdx + marker.length);
	if (openIdx < 0) throw new ApiError(500, `data/${cfg.file} 中找不到数组字面量起始`);
	const closeIdx = matchBracket(text, openIdx);
	if (closeIdx < 0) throw new ApiError(500, `data/${cfg.file} 数组字面量不配平，请手工检查`);

	const inner =
		items.length === 0
			? ""
			: `\n${items.map((item) => `\t${dumpTsValue(item, 1)}`).join(",\n")},\n`;
	const next = `${text.slice(0, openIdx)}[${inner}]${text.slice(closeIdx + 1)}`;
	if (next === text) return false;
	await fs.writeFile(abs, next);
	return true;
}
