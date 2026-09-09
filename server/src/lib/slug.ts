import { pinyin } from "pinyin-pro";
import type { SlugSuggestion } from "@shirone-admin/shared";

/** 标题 → ASCII slug（中文转拼音）。用户显式传入的 slug 只做合法性清洗。 */
export function suggestSlug(title: string): SlugSuggestion {
	const raw = title.trim();
	let slug = raw
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^\w-]+/g, (m) => {
			const py = pinyin(m, { toneType: "none", type: "string", nonZh: "consecutive" });
			return py;
		})
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	let note: string | undefined;
	if (!slug) {
		slug = `post-${Date.now().toString(36)}`;
		note = "标题无法转写，已使用随机标识";
	}
	const adjusted = slug !== raw.toLowerCase().replace(/\s+/g, "-");
	return { slug, adjusted, note };
}

/** 用户显式指定的 slug：只允许字母数字-_ 与中文（中文给编码风险提示） */
export function sanitizeUserSlug(input: string): { slug: string; note?: string } {
	const trimmed = input.trim().replace(/\s+/g, "-");
	if (!trimmed) return { slug: suggestSlug("").slug, note: "空 slug" };
	if (/^[\w-]+$/.test(trimmed)) return { slug: trimmed };
	if (/^[\p{Script=Han}\w-]+$/u.test(trimmed)) {
		return { slug: trimmed, note: "中文 slug 在部分链路（rsync/分享链接）有编码风险，建议改用拼音" };
	}
	return { slug: trimmed.replace(/[^\p{Script=Han}\w-]/gu, ""), note: "已移除非法字符" };
}
