import fs from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { ApiError } from "./errors.js";

/**
 * config/*.yaml 的保注释读写。
 *
 * 内容仓 YAML 注释即文档，整文件重写会全部丢失，因此走 `yaml` 包
 * Document API 逐叶子 patch：已存在键只替换值（Pair 及其注释保留），
 * 数组按整体替换语义处理（丢数组项间注释，可接受）。
 */

export interface YamlPatch {
	path: (string | number)[];
	value: unknown;
}

export async function readYaml(abs: string): Promise<Record<string, unknown>> {
	const raw = await fs.readFile(abs, "utf8").catch(() => null);
	if (raw === null) {
		throw new ApiError(404, `配置文件不存在：${path.basename(abs)}`);
	}
	return (YAML.parse(raw) ?? {}) as Record<string, unknown>;
}

export async function patchYaml(abs: string, patches: YamlPatch[]): Promise<void> {
	if (patches.length === 0) return;
	const raw = await fs.readFile(abs, "utf8").catch(() => "");
	const doc = YAML.parseDocument(raw);
	if (doc.errors.length > 0) {
		throw new ApiError(400, `YAML 解析失败：${doc.errors[0].message}`);
	}
	for (const p of patches) {
		doc.setIn(p.path, p.value);
	}
	await fs.writeFile(abs, doc.toString({ lineWidth: 0 }));
}

/** 把嵌套对象摊平成叶子 patch 列表；数组与标量视为叶子（整体替换） */
export function flattenPatches(obj: Record<string, unknown>, base: (string | number)[] = []): YamlPatch[] {
	const out: YamlPatch[] = [];
	for (const [k, v] of Object.entries(obj)) {
		if (v === undefined) continue;
		const p = [...base, k];
		if (v !== null && typeof v === "object" && !Array.isArray(v)) {
			out.push(...flattenPatches(v as Record<string, unknown>, p));
		} else {
			out.push({ path: p, value: v });
		}
	}
	return out;
}
