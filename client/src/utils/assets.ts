/**
 * 内容仓资源路径 → admin 内预览地址。
 * `/` 开头是内容仓 public 站点绝对路径，其余按 assets 相对路径处理，
 * 两者由 server 分别挂到 /content-public 与 /content-assets（vite 已代理）。
 */
export function contentPreviewUrl(v: unknown): string | undefined {
	const s = typeof v === "string" ? v.trim() : "";
	if (!s) return undefined;
	if (/^https?:\/\//.test(s)) return s;
	if (s.startsWith("/")) return `/content-public${s}`;
	return `/content-assets/${s.replace(/^\.\//, "")}`;
}
