import matter from "gray-matter";
import YAML from "yaml";

/**
 * frontmatter 解析/序列化。
 *
 * 解析用 `yaml` 包（YAML 1.2 core schema）：`2026-09-06` 保持字符串，
 * 保证读写往返不丢格式；序列化用规范化输出器，日期输出为 YAML 裸时间戳
 * （主题 zod `z.date()` 依赖 js-yaml 的 timestamp 解析，带引号会炸）。
 */

export interface ParsedDoc {
	data: Record<string, unknown>;
	body: string;
}

export function parseFrontmatter(raw: string): ParsedDoc {
	// Windows 检出的 CRLF 文件里，紧跟双引号标量的 \r 会让 yaml 解析器
	// 报 "Unexpected scalar at node end"，统一归一化后解析
	const m = matter(raw.replace(/\r\n/g, "\n"), {
		engines: {
			yaml: {
				parse: (s: string) => YAML.parse(s) as Record<string, unknown>,
				stringify: (o: object) => YAML.stringify(o),
			},
		},
	});
	return {
		data: (m.data ?? {}) as Record<string, unknown>,
		body: m.content.replace(/^\r?\n+/, ""),
	};
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?$/;

function quote(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function dumpScalar(v: unknown): string {
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (v === null || v === undefined) return '""';
	const s = String(v);
	if (DATE_RE.test(s) || DATETIME_RE.test(s)) return s;
	return quote(s);
}

function isComposite(v: unknown): v is Record<string, unknown> | unknown[] {
	return v !== null && typeof v === "object";
}

function dumpArray(items: unknown[], indent: string): string {
	return items
		.map((item) => {
			if (isComposite(item) && !Array.isArray(item)) {
				return dumpMap(item, `${indent}  `, `${indent}- `);
			}
			if (Array.isArray(item)) {
				return `${indent}-\n${dumpArray(item, `${indent}  `)}`;
			}
			return `${indent}- ${dumpScalar(item)}`;
		})
		.join("\n");
}

function dumpMap(obj: Record<string, unknown>, indent: string, prefix = ""): string {
	const lines: string[] = [];
	let first = true;
	for (const [k, v] of Object.entries(obj)) {
		const key = /^[\w.-]+$/.test(k) ? k : quote(k);
		const lead = first ? prefix : indent;
		first = false;
		if (isComposite(v)) {
			if (Array.isArray(v)) {
				if (v.length === 0) {
					lines.push(`${lead}${key}: []`);
				} else {
					lines.push(`${lead}${key}:`);
					lines.push(dumpArray(v, indent));
				}
			} else {
				const entries = Object.entries(v);
				if (entries.length === 0) {
					lines.push(`${lead}${key}: {}`);
				} else {
					lines.push(`${lead}${key}:`);
					lines.push(dumpMap(v, `${indent}  `));
				}
			}
		} else {
			lines.push(`${lead}${key}: ${dumpScalar(v)}`);
		}
	}
	return lines.join("\n");
}

/** 输出 `---\n<yaml>---\n\n<body>\n` 的完整文档 */
export function serializeFrontmatter(
	data: Record<string, unknown>,
	orderedKeys: string[],
	body: string,
): string {
	const seen = new Set<string>();
	const entries: Array<[string, unknown]> = [];
	for (const k of orderedKeys) {
		if (k in data && data[k] !== undefined) {
			entries.push([k, data[k]]);
			seen.add(k);
		}
	}
	for (const k of Object.keys(data)) {
		if (!seen.has(k)) entries.push([k, data[k]]);
	}
	const yamlText = entries.map(([k, v]) => dumpMap({ [k]: v }, "")).join("\n");
	return `---\n${yamlText}\n---\n\n${body.trim()}\n`;
}
