import { NodeType, parse, type HTMLElement } from "node-html-parser";
import { NodeHtmlMarkdown, type TranslatorConfigObject } from "node-html-markdown";

/**
 * 简书官方导出包内 HTML 文章的解析与转换（纯函数，无副作用）。
 *
 * 导出事实（社区项目 jianshu2dayone 与官方导出行为证实）：
 * - 包内是完整 HTML 页面，正文在 article/.show-content 等容器里；
 * - 无发布日期字段；图片是 upload-images.jianshu.io 外链（多为 // 协议相对地址）；
 * - 数学公式渲染成 MathML，原始 TeX 藏在 <annotation encoding="application/x-tex">；
 * - 代码块语言在 code 的 class="language-x" / data-language 上；
 * - 表情是 <img class="emoji">，视频/听歌等嵌入是 <video>/<iframe>。
 */

/** 正文容器选择器：按特异性从高到低级联取第一个命中 */
const CONTENT_SELECTORS = [
	"article .show-content",
	".show-content",
	".note-content",
	"article",
	"main",
	"body",
];

/** 与正文无关的页面骨架元素 */
const CHROME_SELECTOR = "script,style,noscript,nav,header,footer,aside,form,button";

export interface ParsedJianshuArticle {
	title: string;
	/** 正文容器的 outerHTML（已剔除页面骨架与标题） */
	contentHtml: string;
	/** 正文纯文本（空白折叠，用于字数与摘要） */
	textContent: string;
}

/** 空白折叠为单空格（跨行也压平），服务层纯文本兜底转换复用 */
export function collapseWs(s: string): string {
	return s.replace(/\s+/g, " ").trim();
}

/** 摘要与字数要排除的非散文元素（代码、公式、页面脚本等） */
const PROSE_SKIP = /^(pre|code|math|annotation|svg|script|style|noscript)$/i;

/**
 * 递归提取可读散文：node-html-parser 的 textContent/structuredText 会把子元素的
 * 原始 HTML 标记一并带出（实证），不能用于摘要。
 */
function extractProse(el: HTMLElement): string {
	let out = "";
	for (const node of el.childNodes) {
		if (node.nodeType === NodeType.TEXT_NODE) {
			out += node.text;
		} else if (node.nodeType === NodeType.ELEMENT_NODE && !PROSE_SKIP.test(node.rawTagName ?? "")) {
			out += ` ${extractProse(node as HTMLElement)} `;
		}
	}
	return out;
}

function escapeHtml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
	return escapeHtml(s).replace(/"/g, "&quot;");
}

/** HTML 全文 → 标题 + 正文容器 + 纯文本；标题兜底链：正文 h1 → <title> 去「 - 简书」→ 文件名 */
export function parseJianshuArticle(html: string, fallbackTitle: string): ParsedJianshuArticle {
	const root = parse(html);
	let content: HTMLElement | null = null;
	for (const selector of CONTENT_SELECTORS) {
		const hit = root.querySelector(selector);
		if (hit) {
			content = hit;
			break;
		}
	}
	if (!content) content = root;
	for (const el of content.querySelectorAll(CHROME_SELECTOR)) el.remove();

	const h1 = content.querySelector("h1");
	let title = collapseWs(h1?.textContent ?? "");
	if (!title) {
		const t = collapseWs(root.querySelector("title")?.textContent ?? "");
		title = t.replace(/\s*[-–—|]\s*简书.*$/, "").trim();
	}
	if (!title) title = fallbackTitle.replace(/\.[^.]*$/, "").trim();
	if (!title) title = "未命名文章";
	// 标题不重复出现在正文里
	h1?.remove();

	return {
		title,
		contentHtml: content.outerHTML,
		textContent: collapseWs(extractProse(content)),
	};
}

export interface MarkdownConversion {
	markdown: string;
	/** 正文里归一化后的图片直链（去重保序） */
	imageUrls: string[];
}

function normalizeUrl(raw: string): string {
	return raw.trim().replace(/^\/\//, "https://");
}

/** DOM 预处理：图片归一、表情转文本、公式转 $..$、图注转斜体、媒体降级为链接、代码语言标注 */
function preprocess(root: HTMLElement): string[] {
	const imageUrls: string[] = [];
	const seen = new Set<string>();

	for (const img of root.querySelectorAll("img")) {
		// 表情占位图：转 alt 文本，避免当远程图下载失败
		if (/\bemoji\b/.test(img.classNames) || img.getAttribute("data-emoji")) {
			const alt =
				collapseWs(img.getAttribute("alt") ?? "") || collapseWs(img.getAttribute("data-emoji") ?? "");
			img.replaceWith(alt);
			continue;
		}
		// 懒加载属性优先（才是原图），协议相对地址补 https
		const raw =
			img.getAttribute("data-original-src") ?? img.getAttribute("data-src") ?? img.getAttribute("src") ?? "";
		const url = normalizeUrl(raw);
		if (!/^https?:\/\//i.test(url)) {
			img.remove();
			continue;
		}
		img.setAttribute("src", url);
		if (!seen.has(url)) {
			seen.add(url);
			imageUrls.push(url);
		}
	}

	// MathML → TeX：找到最外层 math/公式容器，替换为自定义占位标签（TeX 由 translator 原样输出，
	// 走文本节点会被 markdown 转义器把 \ 与 _ 双写，破坏公式渲染）
	for (const ann of root.querySelectorAll('annotation[encoding="application/x-tex"]')) {
		if (!ann.parentNode) continue;
		const tex = collapseWs(ann.textContent ?? "");
		if (!tex) continue;
		let target: HTMLElement = ann;
		let block = false;
		let cur: HTMLElement | null = ann;
		while (cur && cur !== root) {
			const cls = cur.classNames;
			if (cur.rawTagName === "math" || /math|formula/i.test(cls)) {
				target = cur;
				block = cur.rawTagName === "div" || /block/i.test(cls);
			}
			cur = cur.parentNode as HTMLElement | null;
		}
		const tag = block ? "jianshublocktex" : "jianshutex";
		const el = parse(`<${tag} data-tex="${escapeAttr(tex)}"></${tag}>`).querySelector(tag);
		if (el) target.replaceWith(el);
	}

	// 图注 → 斜体行（转换器会直接丢弃 figcaption）
	for (const fig of root.querySelectorAll("figcaption")) {
		const text = collapseWs(fig.textContent ?? "");
		if (!text) {
			fig.remove();
			continue;
		}
		const em = parse(`<em>${escapeHtml(text)}</em>`).querySelector("em");
		if (em) fig.replaceWith(em);
	}

	// 视频/音频/嵌入：降级为链接，避免内容静默丢失
	for (const tag of root.querySelectorAll("video,audio,iframe")) {
		const raw = tag.getAttribute("src") ?? tag.querySelector("source")?.getAttribute("src") ?? "";
		const url = normalizeUrl(raw);
		const label = tag.rawTagName === "video" ? "视频" : tag.rawTagName === "audio" ? "音频" : "嵌入内容";
		if (/^https?:\/\//i.test(url)) {
			const a = parse(`<a href="${escapeAttr(url)}">${label}</a>`).querySelector("a");
			if (a) {
				tag.replaceWith(a);
				continue;
			}
		}
		tag.remove();
	}

	// 代码块语言：class="language-x" / data-language → data-lang，供转换器读进围栏
	for (const code of root.querySelectorAll("pre code")) {
		const m = code.classNames.match(/(?:^|\s)(?:language|lang)-([\w+#.-]+)/);
		const lang = (m?.[1] ?? code.getAttribute("data-language") ?? "").trim();
		if (lang) code.setAttribute("data-lang", lang);
	}

	return imageUrls;
}

/** 公式占位标签 → TeX 原样输出（postprocess 整体替换内容，绕开文本转义） */
const MATH_TRANSLATORS: TranslatorConfigObject = {
	jianshutex: {
		postprocess: (ctx) => `$${ctx.node.getAttribute("data-tex") ?? ""}$`,
		recurse: false,
		preserveIfEmpty: true,
	},
	jianshublocktex: {
		postprocess: (ctx) => `$$\n${ctx.node.getAttribute("data-tex") ?? ""}\n$$`,
		recurse: false,
		preserveIfEmpty: true,
		surroundingNewlines: 2,
	},
};

/** 围栏代码块带语言标注（node-html-markdown 默认不读 language class） */
const CODE_BLOCK_TRANSLATORS: TranslatorConfigObject = {
	code: (ctx) => ({
		prefix: `\`\`\`${ctx.node.getAttribute("data-lang") ?? ""}\n`,
		postfix: "\n```",
		noEscape: true,
		surroundingNewlines: 2,
	}),
};

/** 正文 HTML → Markdown；图片链接保持远程，落仓改写由上层 rewriteImages 负责 */
export function contentHtmlToMarkdown(contentHtml: string): MarkdownConversion {
	const root = parse(contentHtml);
	const imageUrls = preprocess(root);
	let markdown = NodeHtmlMarkdown.translate(
		root.outerHTML,
		{ codeBlockStyle: "fenced", bulletMarker: "-" },
		MATH_TRANSLATORS,
		CODE_BLOCK_TRANSLATORS,
	);
	markdown = markdown.split(String.fromCharCode(0xa0)).join(" ").trim();
	return { markdown, imageUrls };
}

/** 码点安全截断（防拆代理对），空白先折叠 */
export function excerptText(text: string, maxChars: number): string {
	const trimmed = collapseWs(text);
	const chars = Array.from(trimmed);
	if (chars.length <= maxChars) return chars.join("");
	return `${chars.slice(0, maxChars).join("")}…`;
}

/** 字数统计：CJK 逐字计，拉丁词按词计 */
export function countWords(text: string): number {
	const cjk = (text.match(/[一-鿿぀-ヿ]/g) ?? []).length;
	const words = (text.match(/[a-zA-Z0-9]+/g) ?? []).length;
	return cjk + words;
}

/** 按映射把 markdown 里的远程图片链接改写为本地相对路径 */
export function rewriteImages(markdown: string, map: Map<string, string>): string {
	let out = markdown;
	for (const [url, src] of map) {
		if (url !== src) out = out.split(url).join(src);
	}
	return out;
}
