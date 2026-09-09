import sharp from "sharp";
import { ApiError } from "../lib/errors.js";

/**
 * 远程媒体下载（Bangumi 封面 / 音乐音频直链）。
 * 统一防线：URL 必须是公共 http(s)（防 SSRF），content-type 嗅探把关类型，超时与大小上限兜底。
 */

/** 下载上限：图片 8MB / 音频 28MB（multipart 上传上限 30MB 留余量） */
export const IMAGE_DOWNLOAD_CAP = 8 * 1024 * 1024;
export const AUDIO_DOWNLOAD_CAP = 28 * 1024 * 1024;

const PRIVATE_HOST_PATTERNS: RegExp[] = [
	/^localhost$/i,
	/^127\./,
	/^0\./,
	/^10\./,
	/^192\.168\./,
	/^169\.254\./,
	/^172\.(1[6-9]|2\d|3[01])\./,
	/^\[?::1\]?$/,
	/^\[?(?:fe80|fc|fd)[0-9a-f:]*$/i,
];

/** 校验公共 http(s) 地址：拒绝非 http(s) 协议、IP 直连与内网/回环主机 */
export function assertPublicHttpUrl(url: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new ApiError(400, "不是合法的 URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ApiError(400, "只支持 http(s) 地址");
	}
	const host = parsed.hostname.toLowerCase();
	if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
		throw new ApiError(400, "拒绝访问内网、本机或 IP 直连地址");
	}
	return parsed;
}

const IMAGE_MIME_EXT: Record<string, string> = {
	"image/jpeg": ".jpg",
	"image/png": ".png",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/avif": ".avif",
};

const AUDIO_MIME_EXT: Record<string, string> = {
	"audio/mpeg": ".mp3",
	"audio/mp3": ".mp3",
	"audio/mp4": ".m4a",
	"audio/x-m4a": ".m4a",
	"audio/aac": ".aac",
	"audio/ogg": ".ogg",
	"audio/vorbis": ".ogg",
	"audio/opus": ".opus",
	"audio/wav": ".wav",
	"audio/x-wav": ".wav",
	"audio/wave": ".wav",
	"audio/flac": ".flac",
	"audio/x-flac": ".flac",
};

const KNOWN_IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".avif"]);
const KNOWN_AUDIO_EXT = new Set([".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac"]);

interface TypeVerdict {
	ext: string;
	/** 非 空 表示类型不符，值为面向用户的错误信息 */
	kindError?: string;
}

interface DownloadResult {
	buf: Buffer;
	/** 依据 content-type / URL 推导的带扩展名文件名（storage 层再做 asciiName 清洗） */
	fileName: string;
}

async function downloadRemote(
	url: string,
	capBytes: number,
	validate: (contentType: string, urlExt: string) => TypeVerdict,
	fallbackName = "",
): Promise<DownloadResult> {
	const parsed = assertPublicHttpUrl(url);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	try {
		const res = await fetch(parsed, { signal: controller.signal, redirect: "follow" });
		if (!res.ok) throw new ApiError(502, `下载失败：服务返回 ${res.status}`);
		const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
		const urlExt = (parsed.pathname.match(/\.[a-z0-9]+$/) ?? [""])[0].toLowerCase();
		const verdict = validate(contentType, urlExt);
		if (verdict.kindError) throw new ApiError(400, verdict.kindError);
		const declared = Number(res.headers.get("content-length") ?? "");
		if (Number.isFinite(declared) && declared > capBytes) {
			throw new ApiError(413, `文件超过 ${Math.round(capBytes / 1024 / 1024)}MB 上限`);
		}
		const buf = Buffer.from(await res.arrayBuffer());
		if (buf.byteLength > capBytes) {
			throw new ApiError(413, `文件超过 ${Math.round(capBytes / 1024 / 1024)}MB 上限`);
		}
		const ext = verdict.ext || urlExt;
		const base =
			fallbackName.trim() !== ""
				? fallbackName.trim()
				: decodeURIComponent(parsed.pathname.split("/").pop() ?? "").replace(/\.[^.]*$/, "");
		return { buf, fileName: `${base || "download"}${ext}` };
	} catch (e) {
		if (e instanceof ApiError) throw e;
		if ((e as Error).name === "AbortError") throw new ApiError(504, "下载超时（30s），请稍后重试");
		throw new ApiError(502, `无法下载文件：${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

export async function downloadRemoteImage(url: string, fallbackName = ""): Promise<DownloadResult> {
	return downloadRemote(url, IMAGE_DOWNLOAD_CAP, (ct, urlExt) => {
		if (ct.startsWith("image/")) return { ext: IMAGE_MIME_EXT[ct] ?? urlExt };
		if (ct === "" || ct === "application/octet-stream") {
			if (KNOWN_IMAGE_EXT.has(urlExt)) return { ext: urlExt };
			return { ext: "", kindError: `目标不是图片（content-type: ${ct || "未知"}），请确认是图片直链` };
		}
		if (ct === "text/html") {
			return { ext: "", kindError: "目标返回网页而非图片（可能需要登录或有防盗链），请换直链" };
		}
		return { ext: "", kindError: `目标不是图片（content-type: ${ct}）` };
	}, fallbackName);
}

export async function downloadRemoteAudio(url: string, fallbackName = ""): Promise<DownloadResult> {
	return downloadRemote(url, AUDIO_DOWNLOAD_CAP, (ct, urlExt) => {
		if (ct.startsWith("audio/")) return { ext: AUDIO_MIME_EXT[ct] ?? urlExt };
		if (ct === "" || ct === "application/octet-stream") {
			if (KNOWN_AUDIO_EXT.has(urlExt)) return { ext: urlExt };
			return { ext: "", kindError: `目标不是音频（content-type: ${ct || "未知"}），请确认是音频直链` };
		}
		if (ct === "text/html") {
			return { ext: "", kindError: "目标返回网页而非音频（可能需要登录或有防盗链），请换直链" };
		}
		return { ext: "", kindError: `目标不是音频（content-type: ${ct}）` };
	}, fallbackName);
}

/** RIFF 容器头 + WEBP 标记（部分站点 webp 的 content-type/扩展名不可靠，按魔数判定） */
function isWebpBuffer(buf: Buffer): boolean {
	return (
		buf.length > 12 &&
		buf.toString("ascii", 0, 4) === "RIFF" &&
		buf.toString("ascii", 8, 12) === "WEBP"
	);
}

/**
 * webp 转 png（含透明通道）或 jpg（不透明，质量 90）；动图取首帧。
 * 非 webp 或转换失败原样返回，绝不因转换丢图。
 */
export async function convertWebpIfNeeded(
	fileName: string,
	buf: Buffer,
): Promise<{ fileName: string; buf: Buffer }> {
	if (!fileName.toLowerCase().endsWith(".webp") && !isWebpBuffer(buf)) return { fileName, buf };
	try {
		const img = sharp(buf, { animated: false });
		const meta = await img.metadata();
		const toPng = meta.hasAlpha === true;
		const out = toPng ? await img.png().toBuffer() : await img.jpeg({ quality: 90 }).toBuffer();
		const base = fileName.replace(/\.webp$/i, "");
		return { fileName: `${base}${toPng ? ".png" : ".jpg"}`, buf: out };
	} catch {
		return { fileName, buf };
	}
}
