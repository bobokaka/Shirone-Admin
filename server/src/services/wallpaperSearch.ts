import { ApiError } from "../lib/errors.js";
import type { WallpaperCandidate } from "@shirone-admin/shared";

/**
 * 壁纸抓取：safebooru.org 公开 API（SFW 二次元图库，无鉴权），
 * 按目标端尺寸/宽高比过滤翻页凑满一批；关键词无结果自动回退默认壁纸标签。
 */

export type WallpaperTargetKind = "desktop" | "mobile";

const SAFEBOORU_API = "https://safebooru.org/index.php";
/** 每批凑满张数：不满就继续翻页，翻尽后再用默认标签补齐 */
const BATCH = 12;
const PAGE_SIZE = 100;
/** 单标签组合最多翻页数（100 张/页，足够筛出 12 张合格） */
const MAX_PAGES = 6;
/** 随机起始页上限：让每批都有新鲜内容 */
const MAX_PID = 40;

interface SafebooruPost {
	file_url: string;
	sample_url: string;
	width: number;
	height: number;
}

/** 桌面要横图（宽≥1920，1.2~2.4 倍），移动要竖图（高≥1920，高宽 1.2~2.3 倍） */
function fits(p: SafebooruPost, target: WallpaperTargetKind): boolean {
	if (!p.file_url || !p.width || !p.height) return false;
	const r = p.width / p.height;
	return target === "desktop" ? p.width >= 1920 && r >= 1.2 && r <= 2.4 : p.height >= 1920 && r >= 1 / 2.3 && r <= 1 / 1.2;
}

async function fetchPage(tags: string, pid: number): Promise<SafebooruPost[]> {
	const params = new URLSearchParams({
		page: "dapi",
		s: "post",
		q: "index",
		json: "1",
		limit: String(PAGE_SIZE),
		pid: String(pid),
		tags,
	});
	let res: Response;
	try {
		res = await fetch(`${SAFEBOORU_API}?${params}`, {
			headers: { "User-Agent": "Shirone-Admin/1.0" },
			signal: AbortSignal.timeout(15000),
		});
	} catch {
		throw new ApiError(502, "壁纸源（safebooru）不可达");
	}
	if (!res.ok) throw new ApiError(502, `壁纸源响应异常（${res.status}）`);
	// pid 超出总页数时 safebooru 返回 200 + 空 body：视为翻尽
	const text = await res.text();
	if (text.trim() === "") return [];
	try {
		return JSON.parse(text) as SafebooruPost[];
	} catch {
		return [];
	}
}

export async function scrapeWallpapers(
	query: string,
	target: WallpaperTargetKind,
): Promise<{ candidates: WallpaperCandidate[] }> {
	const dims = target === "desktop" ? "width:>=1920" : "width:<=1300 height:>=1920";
	const base = `wallpaper ${dims}`;
	const keyword = query.trim();
	const tagsList = keyword === "" ? [base] : [`${keyword} ${base}`, base];

	const out: WallpaperCandidate[] = [];
	const seen = new Set<string>();
	for (const tags of tagsList) {
		if (out.length >= BATCH) break;
		let start = Math.floor(Math.random() * MAX_PID);
		let page = 0;
		while (page < MAX_PAGES && out.length < BATCH) {
			const posts = await fetchPage(tags, start + page);
			// 起始页超范围或瞬时空响应：从头再翻一次；从头仍空才算翻尽
			if (posts.length === 0) {
				if (start === 0) break;
				start = 0;
				page = 0;
				continue;
			}
			for (const p of posts) {
				if (out.length >= BATCH) break;
				if (!fits(p, target) || seen.has(p.file_url)) continue;
				seen.add(p.file_url);
				out.push({
					imageUrl: p.file_url,
					previewUrl: p.sample_url || p.file_url,
					width: p.width,
					height: p.height,
				});
			}
			if (posts.length < PAGE_SIZE) break;
			page += 1;
		}
	}
	if (out.length === 0) throw new ApiError(502, "未抓到符合条件的壁纸");
	return { candidates: out };
}
