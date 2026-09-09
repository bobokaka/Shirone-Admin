/**
 * 把内容仓中的媒体地址（YAML 里的 src 值）换算成 admin 可预览的 URL。
 * server 在 /content-assets（assets/）与 /content-public（public/）挂了静态服务。
 */
export function previewUrlOf(src: string): string {
	if (!src) return "";
	if (/^https?:\/\//i.test(src) || src.startsWith("data:")) return src;
	if (src.startsWith("assets/")) return `/content-assets/${src.slice("assets/".length)}`;
	if (src.startsWith("/")) return `/content-public${src}`;
	return src;
}

/**
 * 文章正文预览：把 `./images/…` 相对引用重写到 /content-posts/<文章目录>/images/
 * （server 静态路由直读内容仓文章配图）。postPath 形如 `my-post/index.md`。
 */
export function postPreviewBody(body: string, postPath: string): string {
	const dir = postPath
		.replace(/\\/g, "/")
		.replace(/\/index\.md$/, "")
		.replace(/\.md$/, "");
	if (!dir) return body;
	return body.replace(/!\[([^\]]*)\]\((\.{0,2}\/)?images\//g, `![$1](/content-posts/${dir}/images/`);
}

const PROXY_PREFIXES = ["/content-posts/", "/content-public/", "/content-assets/"];

/**
 * md-editor 预览 sanitize：把渲染 HTML 里的本地媒体地址重写为 admin 代理直链，
 * 否则相对/根绝对路径会按页面路由解析而全部裂图：
 * - `./images/…`（需 postPath）→ /content-posts/<文章目录>/images/…
 * - `/xxx`（public 内）→ /content-public/xxx
 * - `assets/xxx` → /content-assets/xxx
 * 已是代理前缀、外链与 data: 的保持原样。
 */
export function localMediaSanitize(html: string, postPath?: string): string {
	const postDir = postPath
		? postPath
				.replace(/\\/g, "/")
				.replace(/\/index\.md$/, "")
				.replace(/\.md$/, "")
		: "";
	return html.replace(
		/(<(?:img|video|audio|source)\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi,
		(m, head: string, _quoted: string, dq: string, sq: string) => {
			const s = dq ?? sq ?? "";
			if (!s || /^(https?:)?\/\//i.test(s) || s.startsWith("data:")) return m;
			if (PROXY_PREFIXES.some((p) => s.startsWith(p))) return m;
			let u = "";
			if (postDir && /^(\.{1,2}\/)?images\//.test(s)) {
				u = `/content-posts/${postDir}/${s.replace(/^(\.{1,2}\/)?/, "")}`;
			} else if (s.startsWith("/")) {
				u = `/content-public${s}`;
			} else if (s.startsWith("assets/")) {
				u = `/content-assets/${s.slice("assets/".length)}`;
			}
			return u ? `${head}"${u}"` : m;
		},
	);
}
