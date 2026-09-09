/**
 * 宽松 JSON 解析：AI 输出的 JSON 常裹在 ```json 围栏里、混有前后说明文字或尾逗号。
 * 全部纯函数且永不抛错——解不出返回 null，由调用方决定回退策略。
 */

/** 剥代码围栏（```json … ```）与 BOM，压缩整行注释 */
export function stripJsonFences(text: string): string {
	return text
		.replace(/^﻿/, "")
		.replace(/```(?:json|JSON)?\s*\n?/g, "")
		.replace(/```\s*$/g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.trim();
}

/** 截取首个 `{` 到与之配平的末个 `}` 之间的片段（容忍 JSON 前后混入说明文字） */
export function extractJsonObject(text: string): string | null {
	const cleaned = stripJsonFences(text);
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
			if (depth === 0) return cleaned.slice(start, i + 1);
		}
	}
	return null;
}

/** 宽松 parse：剥围栏 + 截取对象 + 去尾逗号；失败返回 null */
export function parseLooseJson(text: string): unknown {
	const candidate = extractJsonObject(text) ?? stripJsonFences(text);
	if (candidate === "") return null;
	try {
		return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
	} catch {
		return null;
	}
}
