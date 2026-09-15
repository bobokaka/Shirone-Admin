<script setup lang="ts">
	import { computed, onUnmounted, ref } from "vue";
	import { useRouter } from "vue-router";
	import { ElMessage } from "element-plus";
	import { MdEditor, type ToolbarNames } from "md-editor-v3";
	import type { JianshuPasteResult } from "@shirone-admin/shared";
	import { importApi, postApi } from "../api";
	import { localMediaSanitize } from "../utils/content-media";

	/**
	 * 单篇文章导入向导：简书「单篇粘贴」与「本地导入」共用。
	 * local=true 时第 1 步为本地 md 文件选择（frontmatter 预填元信息，可整文件夹带媒体），
	 * 其余步骤（内容转换 / 文章信息 / 完成）两模式一致。
	 * prefix：前置步骤标题（简书模式传「选择导入方式」，让步骤条从入口页连续显示）。
	 */
	const props = defineProps<{ local?: boolean; prefix?: string }>();
	const emit = defineEmits<{ exit: [] }>();

	const router = useRouter();

	/* ---------- 向导状态机：本地 0 导入文件 → 1 确认内容 → 2 转换 → 3 信息 → 4 完成；简书少一步入口 ---------- */
	const step = ref(0);
	/** 步骤条展示用：前置步骤（如「选择导入方式」）拼在前面，active 相应偏移 */
	const stepOffset = computed(() => (props.prefix ? 1 : 0));
	const steps = computed(() => {
		const base = props.local
			? ["导入文件", "确认内容", "内容转换", "文章信息", "导入完成"]
			: ["粘贴内容", "内容转换", "文章信息", "导入完成"];
		return props.prefix ? [props.prefix, ...base] : base;
	});
	/** 各步序号（本地首步是文件入口，简书第一步即粘贴内容） */
	const S = computed(() =>
		props.local
			? { content: 1, convert: 2, meta: 3, done: 4 }
			: { content: 0, convert: 1, meta: 2, done: 3 },
	);

	const today = (() => {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	})();

	/* ---------- 提供内容（编辑器左编辑右预览；富文本粘贴自动转 Markdown） ---------- */
	/** 精简工具栏：仅常用排版（默认的保存/源码/全屏/预览切换等在此无意义） */
	const pasteToolbars: ToolbarNames[] = [
		"bold",
		"italic",
		"strikeThrough",
		"-",
		"title",
		"quote",
		"unorderedList",
		"orderedList",
		"-",
		"codeRow",
		"code",
		"link",
	];
	const editorId = computed(() => (props.local ? "local-import-editor" : "jianshu-paste"));
	const pasteMd = ref("");
	const pasteLoading = ref(false);
	const converted = ref<{ wordCount: number; imageCount: number } | null>(null);
	/** 正文中远程图片数（去重），内容转换步摘要用 */
	const pasteImageCount = computed(
		() =>
			new Set([...pasteMd.value.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))
				.size,
	);
	const pasteTitle = ref("");
	const pastePublished = ref(today);
	const pasteCategory = ref("");
	const pasteTags = ref<string[]>([]);
	const pasteDraft = ref(true);
	const pasting = ref(false);
	const pasteResult = ref<JianshuPasteResult | null>(null);
	/** 落仓后的正文（转换步双栏编辑/预览用；与 pasteMd 的差异在媒体已本地化） */
	const convertedBody = ref("");
	/* 文章信息（第 3 步）：AI 分析正文补充的博客元信息，用户可改后定稿 */
	const pasteDescription = ref("");
	const suggesting = ref(false);
	const finalizing = ref(false);

	/* 本地文件：frontmatter 提供过元信息时，AI 建议只补空缺、不覆盖用户文件里的值 */
	const fileName = ref("");
	const fmFilled = ref(false);

	/* ---------- 本地媒体（图片/视频/音频）：登记 → 引用匹配 → 转换入库 ---------- */
	const IMG_EXT = /\.(png|jpe?g|webp|gif|avif)$/i;
	const VIDEO_EXT = /\.(mp4|webm|mov|m4v|ogv)$/i;
	const AUDIO_EXT = /\.(mp3|wav|ogg|m4a|flac|aac)$/i;

	type MediaKind = "image" | "video" | "audio";

	function kindOfName(name: string): MediaKind | null {
		if (IMG_EXT.test(name)) return "image";
		if (VIDEO_EXT.test(name)) return "video";
		if (AUDIO_EXT.test(name)) return "audio";
		return null;
	}

	interface MediaPick {
		name: string;
		relPath: string;
		/** 预览地址（/api 直链） */
		url: string;
		kind: MediaKind;
		/** 所属的 md 所在目录（转换时服务端直读入库） */
		dir: string;
	}
	const mediaList = ref<MediaPick[]>([]);
	/** 媒体集变化时重建编辑器，预览才能重新走 sanitize 拿到 blob 地址 */
	const editorKey = ref(0);
	/** 转换后本地媒体入库统计（完成页展示） */
	const localMedia = ref<{ imported: number; missing: string[] }>({ imported: 0, missing: [] });

	/** 原生 HTML 的裸相对 src/poster 归一为 ./ 前缀（编辑器 xss 过滤只放行 ./ ../ / http 等前缀的 src，裸相对会被清空） */
	function normalizeHtmlSrcs(md: string): string {
		return md.replace(
			/((?:src|poster)\s*=\s*)(["'])(?!https?:|data:|blob:|ftp:|#|\/|\.{1,2}\/)([^"']+)\2/gi,
			(_m: string, head: string, q: string, val: string) => `${head}${q}./${val}${q}`,
		);
	}

	/** 引用归一：\ → /、去 query/fragment、%编码解码、去开头 ./ */
	function normRef(target: string): string {
		const clean = target.replace(/\\/g, "/").split("?")[0].split("#")[0];
		let decoded = clean;
		try {
			decoded = decodeURIComponent(clean);
		} catch {
			// 保留原样
		}
		return decoded.replace(/^\.\//, "");
	}

	function refBasename(target: string): string {
		return normRef(target).split("/").pop() ?? "";
	}

	/** 本地可解析引用：非 http/协议头/data:、非站根绝对路径 */
	function isRelativeRef(ref: string): boolean {
		if (ref === "" || ref.startsWith("/")) return false;
		if (/^(https?:)?\/\//i.test(ref) || /^[a-z][\w+.-]*:/i.test(ref)) return false;
		return true;
	}

	interface MediaRef {
		ref: string;
		kind: MediaKind;
		/** markdown ![](ref) 里的 alt（转 artplayer/audio-reader 标题用） */
		alt: string;
		/** 是否来自 html 标签 src 属性（只换地址，不转指令） */
		html: boolean;
	}

	/** 正文里的本地媒体引用：markdown 图片/媒体语法 + img/video/audio/source 标签 src */
	function mediaRefsOf(body: string): Map<string, MediaRef> {
		const out = new Map<string, MediaRef>();
		for (const m of body.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
			const ref = m[2].trim().split(/\s+/)[0];
			if (!isRelativeRef(ref)) continue;
			if (!out.has(ref)) out.set(ref, { ref, kind: kindOfName(ref) ?? "image", alt: m[1], html: false });
		}
		for (const m of body.matchAll(/<(img|video|audio|source)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
			const ref = (m[2] ?? m[3] ?? "").trim();
			if (!isRelativeRef(ref) || out.has(ref)) continue;
			const tag = m[1].toLowerCase();
			out.set(ref, {
				ref,
				kind: kindOfName(ref) ?? (tag === "img" ? "image" : tag === "audio" ? "audio" : "video"),
				alt: "",
				html: true,
			});
		}
		return out;
	}

	/** 引用 → 已登记媒体：先按相对路径（含后缀）匹配，再按文件名兜底 */
	function findMedia(ref: string): MediaPick | undefined {
		const clean = normRef(ref);
		if (clean === "") return undefined;
		const byPath = mediaList.value.find(
			(m) =>
				m.relPath !== "" &&
				(m.relPath === clean || m.relPath.endsWith("/" + clean) || clean.endsWith("/" + m.relPath)),
		);
		if (byPath) return byPath;
		const base = clean.split("/").pop() ?? "";
		return base === "" ? undefined : mediaList.value.find((m) => m.name === base);
	}

	/** 服务端文件夹媒体登记：预览走 /api 直链，转换时服务端直读入库 */
	function addServerMedia(dir: string, entries: { name: string; relPath: string }[]): void {
		let changed = false;
		for (const e of entries) {
			const kind = kindOfName(e.name);
			if (!kind) continue;
			if (mediaList.value.some((m) => m.dir === dir && m.relPath === e.relPath)) continue;
			mediaList.value.push({
				name: e.name,
				relPath: e.relPath,
				url: importApi.localFileUrl(dir, e.relPath),
				kind,
				dir,
			});
			changed = true;
		}
		if (changed) editorKey.value += 1;
	}

	function clearMedia(): void {
		mediaList.value = [];
		editorKey.value += 1;
	}

	onUnmounted(clearMedia);

	const mediaRefList = computed(() => [...mediaRefsOf(pasteMd.value).values()]);
	const relativeCount = computed(() => mediaRefList.value.length);
	const matchedRefs = computed(() => mediaRefList.value.filter((r) => findMedia(r.ref)));
	const matchedCount = computed(() => matchedRefs.value.length);
	/** 未提供文件的本地媒体（按文件名去重） */
	const missingNames = computed(() => [
		...new Set(
			mediaRefList.value
				.filter((r) => !findMedia(r.ref))
				.map((r) => refBasename(r.ref))
				.filter((n) => n !== ""),
		),
	]);

	/* ---------- 文件选择：md 解析 / 媒体登记 ---------- */

	/** 编辑器粘贴捕获：富文本（text/html）转服务端转 Markdown 覆盖编辑区；纯文本交给编辑器默认行为 */
	async function onEditorPaste(ev: ClipboardEvent): Promise<void> {
		const dt = ev.clipboardData;
		if (!dt) return;
		const html = (dt.getData("text/html") ?? "").trim();
		if (html === "") return;
		ev.preventDefault();
		pasteLoading.value = true;
		try {
			const r = await importApi.pastePreview({ html });
			pasteMd.value = normalizeHtmlSrcs(r.markdown);
			converted.value = { wordCount: r.wordCount, imageCount: r.imageCount };
			if (r.title) pasteTitle.value = r.title;
			pasteResult.value = null;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			pasteLoading.value = false;
		}
	}


	/** 读 md 文本：剥 frontmatter 预填元信息 → 服务端转 Markdown（首行一级标题抽出） */
	async function loadMdText(name: string, raw: string): Promise<void> {
		const { fm, body } = parseFrontmatter(raw);
		const r = await importApi.pastePreview({ text: body });
		fileName.value = name;
		pasteMd.value = normalizeHtmlSrcs(r.markdown);
		converted.value = { wordCount: r.wordCount, imageCount: r.imageCount };
		pasteResult.value = null;
		pasteTitle.value = fm.title ?? r.title ?? "";
		if (fm.date) pastePublished.value = fm.date;
		if (fm.category !== "") pasteCategory.value = fm.category;
		if (fm.tags.length > 0) pasteTags.value = fm.tags;
		fmFilled.value = Boolean(fm.title || fm.date || fm.category !== "" || fm.tags.length > 0);
		if (missingNames.value.length > 0) {
			ElMessage.warning(`${missingNames.value.length} 个媒体文件未找到`);
		}
	}

	/* ---------- 唯一入口：系统文件对话框选一个 md，服务端直读其所在目录 ---------- */
	const filePicking = ref(false);

	async function pickLocalFile(): Promise<void> {
		if (filePicking.value) return;
		filePicking.value = true;
		try {
			const r = await importApi.localPickMd();
			if (r.canceled || !r.path) return;
			const segs = r.path.replace(/\\/g, "/").split("/");
			const name = segs.pop() ?? "";
			const dir = segs.join("/");
			if (dir === "" || name === "") return;
			await loadFromMdPath(dir, name);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			filePicking.value = false;
		}
	}

	/** 登记该 md 所在目录的全部媒体，并加载这篇文章 */
	async function loadFromMdPath(dir: string, name: string): Promise<void> {
		pasteLoading.value = true;
		try {
			const r = await importApi.localList(dir);
			addServerMedia(r.dir, r.medias);
			const text = await (await fetch(importApi.localFileUrl(r.dir, name))).text();
			await loadMdText(name, text);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			pasteLoading.value = false;
		}
	}

	/** 重选文章：清当前文章内容回到导入文件步（已登记媒体随之清空，重选时重新登记） */
	function rechoose(): void {
		fileName.value = "";
		pasteMd.value = "";
		converted.value = null;
		pasteResult.value = null;
		pasteTitle.value = "";
		pastePublished.value = today;
		pasteCategory.value = "";
		pasteTags.value = [];
		fmFilled.value = false;
		localMedia.value = { imported: 0, missing: [] };
		clearMedia();
		step.value = 0;
	}

	/** 极简 YAML frontmatter 识别：只取 title / date / category(ies) / tags(keywords)，行内数组与块列表两种写法 */
	function parseFrontmatter(raw: string): {
		fm: { title?: string; date?: string; category: string; tags: string[] };
		body: string;
	} {
		const fm: { title?: string; date?: string; category: string; tags: string[] } = {
			category: "",
			tags: [],
		};
		if (!/^---\r?\n/.test(raw)) return { fm, body: raw };
		const rest = raw.slice(raw.indexOf("\n") + 1);
		const end = rest.match(/^(---|\.\.\.)[ \t]*$/m);
		if (!end || end.index === undefined) return { fm, body: raw };
		const body = rest.slice(end.index + end[0].length).replace(/^\r?\n/, "");
		const cats: string[] = [];
		let listKey: "tags" | "cats" | null = null;
		for (const line of rest.slice(0, end.index).split(/\r?\n/)) {
			const item = line.match(/^\s*-\s+(.+)$/);
			if (item && listKey) {
				(listKey === "tags" ? fm.tags : cats).push(unquote(item[1]));
				continue;
			}
			listKey = null;
			const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
			if (!kv) continue;
			const key = kv[1].toLowerCase();
			const val = kv[2].trim();
			if (key === "tags" || key === "keywords") {
				listKey = "tags";
				fm.tags.push(...inlineList(val));
			} else if (key === "category" || key === "categories") {
				listKey = "cats";
				cats.push(...inlineList(val));
			} else if (key === "title") {
				const t = unquote(val);
				if (t !== "") fm.title = t;
			} else if (key === "date" || key === "published") {
				const m = val.match(/\d{4}-\d{2}-\d{2}/);
				if (m) fm.date = m[0];
			}
		}
		fm.category = cats.join("/");
		return { fm, body };
	}

	function unquote(s: string): string {
		return s.replace(/^['"]/, "").replace(/['"]$/, "").trim();
	}

	function inlineList(s: string): string[] {
		if (s === "") return [];
		const inner = s.startsWith("[") ? s.replace(/^\[/, "").replace(/\]$/, "") : s;
		return inner
			.split(",")
			.map(unquote)
			.filter((x) => x !== "");
	}

	/* ---------- 内容转换（媒体本地化落仓；完成后停留本步双栏预览，下一步再补信息） ---------- */

	function escapeRe(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}

	/** artplayer / audio-reader 指令标题：alt 优先，剥扩展名的文件名兜底，去引号截断 */
	function directiveTitle(alt: string, ref: string): string {
		const base = refBasename(ref).replace(/\.[^.]+$/, "");
		return (alt.trim() || base).replace(/"/g, "'").slice(0, 60) || "媒体";
	}

	/**
	 * 本地媒体入库：
	 * - 图片（markdown / html）→ 文章配图目录（./images/imageN.ext），重写引用
	 * - 视频 / 音频 → public/assets/posts/<slug>/（站根路径），markdown 语法转 artplayer / audio-reader 指令，html src 仅换地址
	 * - 未命中的引用保持原样并记入 missing
	 */
	async function localizeLocalMedia(
		slug: string,
		body: string,
	): Promise<{ body: string; stats: { imported: number; missing: string[] } }> {
		const refs = mediaRefsOf(body);
		if (refs.size === 0) return { body, stats: { imported: 0, missing: [] } };
		const missing = new Set<string>();
		const uploaded = new Map<MediaPick, string>();
		let imported = 0;
		let out = body;
		for (const r of refs.values()) {
			const pick = findMedia(r.ref);
			if (!pick) {
				missing.add(refBasename(r.ref));
				continue;
			}
			let src = uploaded.get(pick);
			if (src === undefined) {
				try {
					const up = await importApi.localCollect({ dir: pick.dir, path: pick.relPath, slug });
					src = up.src;
					uploaded.set(pick, src);
					imported += 1;
				} catch (e) {
					ElMessage.warning(`${pick.name} 入库失败：${(e as Error).message}`);
					missing.add(refBasename(r.ref));
					continue;
				}
			}
			const construct = "!\\[[^\\]]*\\]\\(" + escapeRe(r.ref) + "(?:\\s+\"[^\"]*\")?\\)";
			if (!r.html && r.kind === "video") {
				out = out.replace(
					new RegExp(construct, "g"),
					`::artplayer{src="${src}" title="${directiveTitle(r.alt, r.ref)}"}`,
				);
			} else if (!r.html && r.kind === "audio") {
				out = out.replace(
					new RegExp(construct, "g"),
					`:audio-reader[${directiveTitle(r.alt, r.ref)}]{src="${src}"}`,
				);
			} else {
				out = out.replace(new RegExp(escapeRe(r.ref), "g"), src);
			}
		}
		return { body: out, stats: { imported, missing: [...missing] } };
	}

	/** 上一步就是上一步：已转换则先撤回（删除本次创建的草稿与已入库媒体），回到确认内容步 */
	const reverting = ref(false);

	async function backFromConvert(): Promise<void> {
		if (pasting.value || reverting.value) return;
		if (pasteResult.value) {
			reverting.value = true;
			try {
				await postApi.remove(pasteResult.value.path);
			} catch {
				// 草稿可能已不存在，忽略
			} finally {
				reverting.value = false;
			}
			pasteResult.value = null;
			convertedBody.value = "";
			localMedia.value = { imported: 0, missing: [] };
		}
		step.value = S.value.content;
	}

	async function runPaste(): Promise<void> {
		if (pasteMd.value.trim() === "" || pasting.value) return;
		pasting.value = true;
		try {
			// 标题留空 → 先取 AI 建议（会一并拟标题），AI 不可用则正文首行兜底
			let suggested = false;
			if (pasteTitle.value.trim() === "") {
				await loadSuggestions();
				suggested = true;
			}
			if (pasteTitle.value.trim() === "") pasteTitle.value = fallbackTitle();
			pasteResult.value = await importApi.pasteRun({
				markdown: pasteMd.value,
				options: {
					title: pasteTitle.value.trim(),
					published: pastePublished.value,
					category: pasteCategory.value || undefined,
					tags: pasteTags.value,
					draft: pasteDraft.value,
				},
			});
			// 留在本步展示预览；取落仓正文（图片已重写为本地路径）
			convertedBody.value = (await postApi.detail(pasteResult.value.path)).body;
			// 本地媒体入库：引用按路径/文件名命中登记的文件，上传并重写正文
			if (props.local) {
				const r = await localizeLocalMedia(pasteResult.value.slug, convertedBody.value);
				convertedBody.value = r.body;
				localMedia.value = r.stats;
			}
			ElMessage.success("转换完成");
			if (!suggested) void loadSuggestions(); // 文章信息步的 AI 建议提前预热
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			pasting.value = false;
		}
	}

	/** AI 分析正文 → 回填标题（留空时）/摘要/分类/标签 */
	async function loadSuggestions(): Promise<void> {
		if (pasteMd.value.trim() === "" || suggesting.value) return;
		suggesting.value = true;
		try {
			const r = await importApi.suggestMeta({
				title: pasteTitle.value.trim(),
				markdown: pasteMd.value,
			});
			if (r.title && pasteTitle.value.trim() === "") pasteTitle.value = r.title;
			pasteDescription.value = r.description;
			// 文件 frontmatter 已提供的分类/标签保持用户值，AI 只补空缺
			if (!fmFilled.value || pasteCategory.value === "") pasteCategory.value = r.category;
			if (!fmFilled.value || pasteTags.value.length === 0) pasteTags.value = r.tags;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			suggesting.value = false;
		}
	}

	/** 无标题且 AI 不可用时的兜底：正文首个非空行剥掉 markdown 记号，截 30 字 */
	function fallbackTitle(): string {
		const line =
			pasteMd.value
				.trim()
				.split(/\r?\n/)
				.map((l) => l.replace(/^#{1,6}\s*/, "").replace(/[*_`>~[\]()#]/g, "").trim())
				.find((l) => l !== "") ?? "";
		return line.slice(0, 30) || "未命名文章";
	}

	/** 文章信息定稿：把 AI 补充（或手改）的元信息写回已转换生成的文章（正文用转换后的最新版，含已入库的本地媒体引用） */
	async function finishPaste(): Promise<void> {
		if (!pasteResult.value || finalizing.value) return;
		finalizing.value = true;
		try {
			const f = await postApi.detail(pasteResult.value.path);
			await postApi.save({
				path: pasteResult.value.path,
				meta: {
					title: pasteTitle.value.trim(),
					published: pastePublished.value,
					category: pasteCategory.value || "",
					tags: pasteTags.value,
					description: pasteDescription.value.trim(),
					draft: pasteDraft.value,
				},
				body: convertedBody.value || f.body,
			});
			step.value = S.value.done;
			ElMessage.success("导入完成");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			finalizing.value = false;
		}
	}

	/** 预览 sanitize：仓库内媒体重写为 admin 代理直链；未入库的本地媒体引用换成 blob（视频/音频换成可播放元素） */
	function withLocalBlobs(html: string): string {
		if (mediaList.value.length === 0) return html;
		// 已是 video/audio/source 标签的：相对 src 换 blob
		let out = html.replace(
			/(<(?:video|audio|source)\b[^>]*?\bsrc\s*=\s*)("([^"]*)"|'([^']*)')/gi,
			(m: string, head: string, _q: string, dq: string, sq: string) => {
				const s = dq ?? sq ?? "";
				if (!isRelativeRef(s)) return m;
				const pick = findMedia(s);
				return pick ? `${head}"${pick.url}"` : m;
			},
		);
		// markdown 的 ![](x.mp4) 渲染成 <img>：命中视频/音频换成可播放元素，命中图片换预览地址
		out = out.replace(/<img\b[^>]*>/gi, (tag: string) => {
			const m = tag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
			if (!m) return tag;
			const s = (m[1] ?? m[2] ?? "").trim();
			if (!isRelativeRef(s)) return tag;
			const pick = findMedia(s);
			if (!pick) return tag;
			if (pick.kind === "video") {
				return `<video controls preload="metadata" style="max-width: 100%" src="${pick.url}"></video>`;
			}
			if (pick.kind === "audio") {
				return `<audio controls style="width: 100%" src="${pick.url}"></audio>`;
			}
			return tag.replace(m[0], `src="${pick.url}"`);
		});
		return out;
	}

	/** 提供内容步预览：本地媒体先换 blob（须在仓库地址重写前，否则 assets/ 等前缀会被先改写），仓库媒体再走代理 */
	function mediaSanitize(html: string): string {
		return localMediaSanitize(withLocalBlobs(html));
	}

	/** 转换步预览：已落仓正文（./images/、/assets/ 等）按文章路径重写为代理直链，未入库引用用 blob 兜底 */
	function convertSanitize(html: string): string {
		return localMediaSanitize(withLocalBlobs(html), pasteResult.value?.path);
	}

	/** 完成页：导入下一篇（本地）/ 粘贴下一篇（简书）→ 回到第 1 步 */
	function restart(): void {
		rechoose();
		pasteDescription.value = "";
		convertedBody.value = "";
		step.value = 0;
	}

	function goEdit(): void {
		if (pasteResult.value) router.push({ path: "/posts/edit", query: { path: pasteResult.value.path } });
	}

	/** 标题输入粘贴兜底：剪贴板只有富文本（无 text/plain，从网页复制常见）时提取纯文本，压成单行 */
	function onTitlePaste(ev: ClipboardEvent): void {
		const dt = ev.clipboardData;
		if (!dt) return;
		const plain = (dt.getData("text/plain") ?? "").trim();
		if (plain !== "") return; // 有纯文本走编辑器默认行为
		const html = (dt.getData("text/html") ?? "").trim();
		if (html === "") return;
		ev.preventDefault();
		const div = document.createElement("div");
		div.innerHTML = html;
		const text = (div.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text === "") return;
		const input = ev.target as HTMLInputElement;
		const start = input.selectionStart ?? pasteTitle.value.length;
		const end = input.selectionEnd ?? start;
		pasteTitle.value = (pasteTitle.value.slice(0, start) + text + pasteTitle.value.slice(end)).slice(0, 100);
	}
</script>

<template>
	<div class="wizard">
		<el-steps :active="step + stepOffset" align-center finish-status="success" class="steps">
			<el-step v-for="t in steps" :key="t" :title="t" />
		</el-steps>

		<!-- ===== 本地导入 第 1 步：导入文件（系统对话框选一个 md） ===== -->
		<div v-if="local && step === 0" class="step-body" v-loading="pasteLoading || filePicking">
			<div
				class="drop-zone"
				role="button"
				tabindex="0"
				@click="pickLocalFile"
				@keydown.enter.prevent="pickLocalFile"
				@dragover.prevent
				@drop.prevent
			>
				<el-icon :size="44"><UploadFilled /></el-icon>
				<div class="upload-text">{{ fileName ? `已选：${fileName}（点击重选）` : "选择 Markdown 文件" }}</div>
			</div>
			<div class="step-footer">
				<el-button type="primary" :disabled="!fileName" @click="step = S.content">下一步</el-button>
			</div>
		</div>

		<!-- ===== 确认内容（本地第 2 步 / 简书第 1 步：信息条 + 标题 + 编辑器） ===== -->
		<div v-else-if="step === S.content" class="step-body" v-loading="pasteLoading">
			<div v-if="local" class="file-bar">
				<el-icon :size="20"><Document /></el-icon>
				<span class="file-name">{{ fileName }}</span>
				<span class="muted file-stats">
					· {{ converted?.wordCount ?? pasteMd.length }}{{ converted ? " 字" : " 字符" }} · 远程图片
					{{ pasteImageCount }} 张
					<template v-if="relativeCount > 0">
						· 本地媒体 {{ matchedCount }}/{{ relativeCount
						}}<template v-if="missingNames.length > 0">
							（缺 {{ missingNames.slice(0, 3).join("、") }}{{ missingNames.length > 3 ? " 等" : "" }}）</template
						>
					</template>
				</span>
				<el-button size="small" plain :disabled="pasting" @click="rechoose">重选文章</el-button>
			</div>

			<div class="paste-head">
				<span class="paste-head-label">文章标题</span>
				<el-input v-model="pasteTitle" size="large" clearable @paste="onTitlePaste" />
			</div>
			<div class="paste-editor" @paste.capture="onEditorPaste">
				<MdEditor
					:editor-id="editorId"
					:key="editorKey"
					v-model="pasteMd"
					:toolbars="pasteToolbars"
					:preview="true"
					:footers="[]"
					:sanitize="mediaSanitize"
					:placeholder="local ? '内容已读取，可在此微调后再转换…' : '在此粘贴文章内容…'"
				/>
			</div>
			<p v-if="converted && !local" class="muted converted-line">
				已转换：{{ converted.wordCount }} 字 · 图片 {{ converted.imageCount }} 张（导入时自动下载到文章目录）
			</p>

			<div class="step-footer">
				<el-button v-if="local" @click="step = 0">上一步</el-button>
				<el-button v-else @click="emit('exit')">上一步</el-button>
				<el-button type="primary" :disabled="pasteMd.trim() === ''" @click="step = S.convert">
					下一步
				</el-button>
			</div>
		</div>

		<!-- ===== 内容转换（媒体本地化落仓；完成后停留本步双栏预览，下一步再补信息） ===== -->
		<div v-else-if="step === S.convert" class="step-body">
			<div class="panel paste-convert fill">
				<div class="panel-head">
					<span>内容转换</span>
				</div>

				<!-- 转换前：概要与启动 -->
				<div v-if="!pasteResult" class="convert-intro">
					<span class="convert-doc-icon"><el-icon :size="34"><Document /></el-icon></span>
					<div class="convert-doc">
						<div class="convert-doc-title">{{ pasteTitle || "未命名" }}</div>
						<div class="convert-doc-sub muted">
							{{ converted?.wordCount ?? pasteMd.length }}{{ converted ? " 字" : " 字符" }} · 远程图
							{{ pasteImageCount
							}}<template v-if="local && relativeCount > 0">· 本地媒体 {{ matchedCount }}/{{ relativeCount }}</template>
						</div>
					</div>
					<el-button
						type="primary"
						size="large"
						:loading="pasting"
						:disabled="pasteMd.trim() === ''"
						@click="runPaste"
					>
						开始转换
					</el-button>
				</div>

				<!-- 转换后：结果统计 + 左右双栏（左源码可微调，右预览） -->
				<template v-else>
					<p class="convert-done-line">
						<span class="ok-text">✓ 转换完成</span>
						<span class="muted">
							<template v-if="pasteResult.images > 0">· 图 {{ pasteResult.images }}</template
							><template v-if="local && localMedia.imported > 0">
								· 媒体 {{ localMedia.imported }}</template
							><template v-if="pasteResult.failedImages.length">
								· 失败 {{ pasteResult.failedImages.length }}</template
							><template v-if="local && localMedia.missing.length > 0">
								· 缺 {{ localMedia.missing.length }}</template
							>
						</span>
					</p>
					<div class="paste-editor convert-editor" v-loading="pasting">
						<MdEditor
							:editor-id="`${editorId}-convert`"
							v-model="convertedBody"
							:toolbars="pasteToolbars"
							:preview="true"
							:footers="[]"
							:sanitize="convertSanitize"
							placeholder=""
						/>
					</div>
				</template>
			</div>

			<div class="step-footer">
				<el-button :disabled="pasting" :loading="reverting" @click="backFromConvert">上一步</el-button>
				<el-button type="primary" :disabled="!pasteResult" @click="step = S.meta">下一步</el-button>
			</div>
		</div>

		<!-- ===== 文章信息（AI 补充 / frontmatter 预填，确认后写回文章） ===== -->
		<div v-else-if="step === S.meta" class="step-body">
			<div class="panel meta-panel" v-loading="suggesting">
				<div class="panel-head">
					<span>文章信息</span>
					<el-button size="small" text type="primary" :disabled="suggesting" @click="loadSuggestions">
						重新分析
					</el-button>
				</div>
				<el-form label-width="120px" class="opts-form">
					<el-form-item label="标题">
						<el-input
							v-model="pasteTitle"
							placeholder="AI 拟定或自动识别，可修改"
							style="width: 420px"
							@paste="onTitlePaste"
						/>
					</el-form-item>
					<el-form-item label="摘要">
						<el-input
							v-model="pasteDescription"
							type="textarea"
							:rows="3"
							maxlength="200"
							show-word-limit
							placeholder="列表与分享卡展示的一句话摘要"
						/>
					</el-form-item>
					<el-form-item label="分类">
						<el-input v-model="pasteCategory" placeholder="可空" style="width: 240px" />
					</el-form-item>
					<el-form-item label="标签">
						<el-select
							v-model="pasteTags"
							multiple
							filterable
							allow-create
							default-first-option
							placeholder="可空"
							style="width: 360px"
						/>
					</el-form-item>
					<el-form-item label="发布日期">
						<el-date-picker
							v-model="pastePublished"
							type="date"
							value-format="YYYY-MM-DD"
							style="width: 180px"
						/>
					</el-form-item>
					<el-form-item label="导入为草稿">
						<el-switch v-model="pasteDraft" />
					</el-form-item>
				</el-form>
			</div>

			<div class="step-footer">
				<el-button :disabled="finalizing" @click="step = S.convert">上一步</el-button>
				<el-button
					type="primary"
					:loading="finalizing"
					:disabled="suggesting"
					@click="finishPaste"
				>
					完成导入
				</el-button>
			</div>
		</div>

		<!-- ===== 第 4 步：完成 ===== -->
		<div v-else class="step-body">
			<div class="panel">
				<div class="panel-head">导入完成</div>
				<p class="done-line">
					✓ {{ pasteResult?.title }} → <code class="done-path">{{ pasteResult?.path }}</code>
					<span class="muted">
						（图 {{ pasteResult?.images ?? 0 }}<template v-if="local && localMedia.imported > 0">
							· 媒体 {{ localMedia.imported }}</template
						>）
					</span>
				</p>
				<div v-if="pasteResult?.failedImages.length" class="fail-list">
					<p>⚠ {{ pasteResult.failedImages.length }} 张图片下载失败：</p>
					<p v-for="u in pasteResult.failedImages" :key="u" class="fail-url">{{ u }}</p>
				</div>
				<div v-if="local && localMedia.missing.length > 0" class="fail-list">
					<p>⚠ {{ localMedia.missing.length }} 个媒体文件未提供：</p>
					<p v-for="n in localMedia.missing" :key="n" class="fail-url">{{ n }}</p>
				</div>
			</div>
			<div class="step-footer">
				<el-button @click="goEdit">去文章编辑</el-button>
				<el-button type="primary" @click="restart">
					{{ local ? "导入下一篇" : "粘贴下一篇" }}
				</el-button>
			</div>
		</div>
	</div>
</template>

<style scoped>
	/* ---- 向导骨架：步骤条 + 步骤体铺满内容区 ---- */
	.wizard {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.steps {
		flex: none;
		margin: 8px 0 22px;
	}
	.steps :deep(.el-step__title) {
		font-size: 20px;
		line-height: 1.4;
	}
	.step-body {
		flex: 1;
		min-height: 320px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.step-footer {
		margin-top: auto;
		padding-top: 0;
		display: flex;
		justify-content: center;
		gap: 14px;
	}

	/* ---- 第 1 步：文件选择 / 标题 + 编辑器 ---- */
	.drop-zone {
		flex: none;
		width: 100%;
		max-width: 780px;
		margin: auto auto 0; /* 顶部 auto 吸收余量，让下方补充入口贴近上传区 */
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 44px 24px;
		border: 1px dashed rgba(99, 102, 241, 0.45);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.5);
		cursor: pointer;
		text-align: center;
		transition:
			border-color 0.2s ease,
			background 0.2s ease;
	}
	.drop-zone:hover,
	.drop-zone:focus-visible {
		border-color: var(--el-color-primary);
		background: rgba(99, 102, 241, 0.06);
		outline: none;
	}
	.upload-text {
		font-size: 20px;
		margin-top: 6px;
	}
	.file-bar {
		flex: none;
		display: flex;
		align-items: center;
		gap: 8px;
		margin: 0 20px 10px;
		padding: 10px 16px;
		border: 1px solid var(--hairline);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.4);
		font-size: 20px;
	}
	.file-name {
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.paste-head {
		flex: none;
		margin: 0 20px 10px;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.paste-head-label {
		flex: none;
		font-size: 20px;
		color: var(--text-sub);
	}
	.paste-head :deep(.el-input) {
		flex: 1;
	}
	/* 编辑器：与文章编辑器同款（左编辑右预览），铺满步骤体剩余高度 */
	.paste-editor {
		flex: 1;
		min-height: 0;
		margin: 0 20px;
	}
	.paste-editor :deep(.md-editor) {
		height: 100%;
	}
	.paste-editor :deep(.md-editor-preview-wrapper) {
		border-left: 1px solid var(--hairline);
	}
	.paste-editor :deep(.md-editor-preview-wrapper),
	.paste-editor :deep(.md-editor-preview) {
		background: #fcfcfd;
	}
	.converted-line {
		font-size: 20px;
		margin: 0;
	}
	.file-stats {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* ---- 卡内分区：轻底描边面板 ---- */
	.panel {
		border: 1px solid var(--hairline);
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.35);
		padding: 16px 18px;
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
		font-weight: 600;
		font-size: 20px;
	}
	.panel.fill {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.opts-form {
		max-width: 600px;
	}

	/* ---- 第 2 步：内容转换 —— 概要启动 / 完成后双栏编辑预览 ---- */
	.paste-convert .panel-head {
		margin-bottom: 14px;
	}
	.convert-intro {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		text-align: center;
	}
	.convert-doc-icon {
		width: 84px;
		height: 84px;
		border-radius: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		background: linear-gradient(135deg, #6366f1, #c084fc);
		box-shadow: 0 10px 26px rgba(99, 102, 241, 0.35);
	}
	.convert-doc-title {
		font-size: 24px;
		font-weight: 600;
	}
	.convert-doc-sub {
		font-size: 20px;
	}
	.convert-done-line {
		flex: none;
		font-size: 20px;
		margin: 0 0 12px;
	}
	.convert-done-line .ok-text {
		color: var(--el-color-success);
		font-weight: 600;
	}
	.convert-editor {
		margin: 0;
	}
	.meta-panel {
		width: 100%;
		max-width: 780px;
		margin: 0 auto;
	}

	/* ---- 第 4 步：完成 ---- */
	.done-line {
		font-size: 20px;
		margin: 0 0 4px;
	}
	.done-path {
		font-family: Consolas, monospace;
	}
	.fail-list p {
		font-size: 20px;
		margin: 4px 0;
		color: var(--el-color-warning);
	}
	.fail-url {
		font-family: Consolas, monospace;
		word-break: break-all;
	}
	.wizard :deep(.md-editor-preview) {
		font-size: 20px;
	}
</style>
