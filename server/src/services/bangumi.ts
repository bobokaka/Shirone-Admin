import type { BangumiCandidate, BangumiDetail } from "@shirone-admin/shared";
import { ApiError } from "../lib/errors.js";

/** Bangumi 开放 API（https://bangumi.github.io/api/）：免费无鉴权，官方要求自定义 User-Agent */
const BANGUMI_API_BASE = "https://api.bgm.tv";
const USER_AGENT = "Shirone-Admin/1.0 (blog content admin; https://bgm.tv)";

interface BangumiSubjectSummary {
	id: number;
	name?: string;
	name_cn?: string;
	date?: string;
	eps?: number;
	total_episodes?: number;
	images?: { large?: string; common?: string; medium?: string; small?: string };
	rating?: { score?: number };
	summary?: string;
}

interface BangumiSubjectDetail extends BangumiSubjectSummary {
	infobox?: Array<{ key?: string; value?: unknown }>;
	tags?: Array<{ name?: string; count?: number }>;
}

async function bangumiFetch<T>(url: string, init: RequestInit = {}, timeoutMs = 12_000): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(url, {
			...init,
			signal: controller.signal,
			headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(init.headers ?? {}) },
		});
		const text = await res.text();
		if (!res.ok) {
			const detail = text.slice(0, 200).replace(/\s+/g, " ");
			throw new ApiError(502, `Bangumi 服务返回 ${res.status}${detail ? `：${detail}` : `（${res.statusText}）`}`);
		}
		return JSON.parse(text) as T;
	} catch (e) {
		if (e instanceof ApiError) throw e;
		if ((e as Error).name === "AbortError") throw new ApiError(504, "Bangumi 请求超时，请稍后重试");
		throw new ApiError(502, `无法连接 Bangumi：${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

function toCandidate(s: BangumiSubjectSummary): BangumiCandidate {
	const nameCn = (s.name_cn ?? "").trim();
	return {
		id: s.id,
		title: nameCn !== "" ? nameCn : (s.name ?? "").trim(),
		originalTitle: (s.name ?? "").trim(),
		year: typeof s.date === "string" ? s.date.slice(0, 4) : "",
		cover: s.images?.large ?? s.images?.common ?? s.images?.medium,
		summary: (s.summary ?? "").trim(),
		eps: Math.max(0, Math.round(s.eps ?? s.total_episodes ?? 0)),
		bangumiScore:
			typeof s.rating?.score === "number" && s.rating.score > 0 ? Math.round(s.rating.score * 10) / 10 : undefined,
		link: `https://bgm.tv/subject/${s.id}`,
	};
}

/** 搜索番剧条目（type 2 = 动画）。官方 spec 的 filter.type 是数组，个别部署只认标量：400 时降级重试 */
export async function searchBangumi(keyword: string, limit = 8): Promise<BangumiCandidate[]> {
	const run = (filterType: unknown) =>
		bangumiFetch<{ data?: BangumiSubjectSummary[] }>(`${BANGUMI_API_BASE}/v0/search/subjects?limit=${limit}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ keyword, filter: { type: filterType, sort: "match" } }),
		});
	let res: { data?: BangumiSubjectSummary[] };
	try {
		res = await run([2]);
	} catch (e) {
		if (e instanceof ApiError && e.message.includes("返回 400")) {
			res = await run(2);
		} else {
			throw e;
		}
	}
	return (res.data ?? []).map(toCandidate);
}

/** infobox 值归一为文本：string 或 Array<string | {v}>（与主题仓 Bangumi 同步脚本同构） */
function infoboxValueString(v: unknown): string {
	if (typeof v === "string") return v.trim();
	if (Array.isArray(v)) {
		return v
			.map((item) =>
				typeof item === "string"
					? item.trim()
					: item !== null && typeof item === "object" && "v" in item
						? String((item as { v?: unknown }).v ?? "").trim()
						: "",
			)
			.filter((s) => s !== "")
			.join("、");
	}
	return "";
}

/** 制作公司候选键：与主题仓 extractStudioFromInfobox 保持同序 */
const STUDIO_KEYS = ["动画制作", "制作", "製作", "开发", "Animation Production"];

function extractStudio(infobox: Array<{ key?: string; value?: unknown }> | undefined): string | undefined {
	if (!Array.isArray(infobox)) return undefined;
	for (const key of STUDIO_KEYS) {
		const hit = infobox.find((i) => i?.key === key);
		if (!hit) continue;
		const v = infoboxValueString(hit.value);
		if (v !== "") return v;
	}
	return undefined;
}

/** infobox 日期值 → YYYY-MM：兼容 2018-10-05 / 2018年10月 / 2018 */
function monthValue(raw: unknown): string | undefined {
	const v = infoboxValueString(raw);
	if (v === "") return undefined;
	const iso = v.match(/^(\d{4})-(\d{1,2})/);
	if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}`;
	const cn = v.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
	if (cn) return `${cn[1]}-${cn[2].padStart(2, "0")}`;
	if (/^(19|20)\d{2}$/.test(v)) return v;
	return undefined;
}

function infoboxMonth(infobox: Array<{ key?: string; value?: unknown }> | undefined, keys: string[]): string | undefined {
	for (const key of keys) {
		const hit = infobox?.find((i) => i?.key === key);
		if (!hit) continue;
		const v = monthValue(hit.value);
		if (v) return v;
	}
	return undefined;
}

export async function fetchBangumiSubject(id: number): Promise<BangumiDetail> {
	const s = await bangumiFetch<BangumiSubjectDetail>(`${BANGUMI_API_BASE}/v0/subjects/${id}`);
	const start = infoboxMonth(s.infobox, ["放送开始", "开始"]);
	const end = infoboxMonth(s.infobox, ["放送结束", "结束"]);
	const genres = (s.tags ?? [])
		.filter((t) => typeof t?.name === "string" && t.name.trim() !== "")
		.sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
		.map((t) => t.name!.trim())
		.slice(0, 4);
	return {
		...toCandidate(s),
		studio: extractStudio(s.infobox),
		period: start ? { start, ...(end && end !== start ? { end } : {}) } : undefined,
		genres,
	};
}
