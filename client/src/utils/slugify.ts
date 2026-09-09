import { pinyin } from "pinyin-pro";

/**
 * 标题 → ASCII 标识（中文转拼音，与 server/src/lib/slug.ts 同规则）。
 * 用于标识类字段（设备 id / 曲目 id / 项目 key / 书架 key）的自动生成，
 * 无法转写时回退随机短标识。
 */
export function slugifyText(raw: string): string {
	const slug = raw
		.trim()
		.toLowerCase()
		.replace(/[\s_]+/g, "-")
		.replace(/[^\w-]+/g, (m) => pinyin(m, { toneType: "none", type: "string", nonZh: "consecutive" }))
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48)
		.replace(/-+$/g, "");
	return slug || `id-${Date.now().toString(36)}`;
}
