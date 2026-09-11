<script setup lang="ts">
	import { computed, onMounted, ref, watch } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import type { UploadRequestOptions } from "element-plus";
	import { Icon } from "@iconify/vue";
	import * as prettier from "prettier/standalone";
	import * as pluginHtml from "prettier/plugins/html";
	import * as pluginPostcss from "prettier/plugins/postcss";
	import type { FaviconItem, ProfileLink, SiteMediaResult } from "@shirone-admin/shared";
	import { aiApi, mediaApi, settingsApi } from "../api";
	import { previewUrlOf } from "../utils/content-media";
	import { TIMEZONE_OPTIONS } from "../utils/timezones";
	import AiTextInput from "../components/AiTextInput.vue";
	import HtmlCodeEditor from "../components/HtmlCodeEditor.vue";
	import PreviewPanel from "../components/PreviewPanel.vue";
	import SiteImageUpload from "../components/SiteImageUpload.vue";
	import WallpaperRecommendDialog from "../components/WallpaperRecommendDialog.vue";

	const tab = ref("basic");
	const loading = ref(false);
	const saving = ref(false);

	/* ---------- 基础信息（site.yaml + profile.yaml）---------- */
	const siteForm = ref({ title: "", subtitle: "" });
	const generalForm = ref({ site: "", base: "", timeZone: "" });
	const favicons = ref<FaviconItem[]>([]);
	/** 主题默认图标（只读提示）：内容仓 favicon 为空时的实际生效值 */
	const themeFavicons = ref<FaviconItem[]>([]);

	/* ---------- 个人资料（profile.yaml）---------- */
	const profileForm = ref({ avatar: "", name: "", bio: "" });
	const profileLinks = ref<ProfileLink[]>([]);

	/* ---------- 页脚（footer.yaml + footer.html）---------- */
	const footerEnable = ref(false);
	const footerHtml = ref("");
	const formatting = ref(false);

	/** Prettier（standalone + html 插件，内嵌 <style> 走 postcss）格式化页脚 HTML */
	async function formatFooterHtml(): Promise<void> {
		if (footerHtml.value.trim() === "" || formatting.value) return;
		formatting.value = true;
		try {
			const out = await prettier.format(footerHtml.value, {
				parser: "html",
				plugins: [pluginHtml, pluginPostcss],
				printWidth: 100,
			});
			footerHtml.value = out.replace(/\s+$/, "");
		} catch (e) {
			ElMessage.error(`格式化失败：${(e as Error).message}`);
		} finally {
			formatting.value = false;
		}
	}

	/* ---------- 页脚图片库：托管目录清单，上传 / 在线导入落仓后复制路径粘进内容 ---------- */

	const footerLib = ref<SiteMediaResult[]>([]);
	const footerUrl = ref("");
	const footerImporting = ref(false);
	const footerUrlValid = computed(() => /^https?:\/\/\S+$/i.test(footerUrl.value.trim()));

	async function loadFooterLib(): Promise<void> {
		try {
			footerLib.value = await mediaApi.siteImages("footer");
		} catch {
			// 清单失败不阻断编辑，列表留空
		}
	}

	async function uploadFooterImage(options: UploadRequestOptions): Promise<void> {
		try {
			const r = await mediaApi.siteImage("footer", options.file as File);
			await loadFooterLib();
			ElMessage.success(`已上传 ${r.src}`);
			options.onSuccess(r);
		} catch (e) {
			options.onError(e as unknown as Parameters<typeof options.onError>[0]);
			ElMessage.error((e as Error).message);
		}
	}

	/** 在线图片直链：服务端代取落 public/images/footer/（webp 自动转 png/jpg），进图片库 */
	async function importFooterImage(): Promise<void> {
		const url = footerUrl.value.trim();
		if (!footerUrlValid.value || footerImporting.value) return;
		footerImporting.value = true;
		try {
			const r = await mediaApi.siteImageImport({ target: "footer", url });
			await loadFooterLib();
			footerUrl.value = "";
			ElMessage.success(`已导入 ${r.src}`);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			footerImporting.value = false;
		}
	}

	/** 仓内路径（显示用）：/xxx → public/xxx；assets/xxx 原样 */
	function footerRepoPath(src: string): string {
		return src.startsWith("/") ? `public${src}` : src;
	}

	async function copyFooterImgSrc(src: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(src);
			ElMessage.success("已复制路径");
		} catch {
			ElMessage.error("复制失败，请手动复制");
		}
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	/** 近似还原主题 FooterBar（m3-blog-footer）的渲染：注入内容在版权行上方 */
	const footerPreviewDoc = computed(() => {
		const name = escapeHtml(profileForm.value.name || siteForm.value.title || "Shirone");
		const year = new Date().getFullYear();
		/** srcdoc iframe 的相对地址解析依浏览器而异：本地 src 一律重写为带 origin 的绝对代理地址，确保预览必显 */
		const rewriteImgSrc = (html: string): string =>
			html.replace(/<img\b[^>]*>/gi, (tag) =>
				tag.replace(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i, (m2, dq: string, sq: string) => {
					const s = dq || sq;
					if (!s) return m2;
					const u = previewUrlOf(s);
					return `src="${/^https?:\/\//i.test(u) || u.startsWith("data:") ? u : `${window.location.origin}${u}`}"`;
				}),
			);
		const custom = footerEnable.value
			? rewriteImgSrc(footerHtml.value.replace(/<!--[\s\S]*?-->/g, "").trim())
			: "";
		return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;background:linear-gradient(#fafaff,#f0f0f6);font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans SC",sans-serif;color:#49454f}
.stage{height:96px;display:flex;align-items:center;justify-content:center;color:#9a93b2;font-size:13px;letter-spacing:.08em}
:root{--line:#cac6d8;--primary:#6750a4}
.divider{border-top:1px dashed var(--line);margin:2.5rem 2rem 1.5rem}
.inner{display:flex;flex-direction:column;align-items:center;gap:6px;margin:0 auto 44px;padding:0 24px;text-align:center}
.text,.custom-slot{font-size:13px;line-height:1.7}
a{font-weight:500;color:var(--primary);text-decoration:none}
.sep{margin:0 8px;color:var(--line)}
.flex{display:flex}.flex-wrap{flex-wrap:wrap}.justify-center{justify-content:center}.items-center{align-items:center}
.gap-2{gap:8px}.gap-3{gap:12px}.gap-4{gap:16px}.text-xs{font-size:12px}
.opacity-75{opacity:.75}.opacity-80{opacity:.8}.opacity-90{opacity:.9}
</style></head><body>
<div class="stage">（页面内容区域示意）</div>
<div class="divider"></div>
<div class="inner">
${custom ? `<div class="custom-slot">${custom}</div>` : ""}
<p class="text">&copy; ${year} ${name}. All Rights Reserved.<span class="sep">/</span><a href="#">RSS</a><span class="sep">/</span><a href="#">Atom</a><span class="sep">/</span><a href="#">Sitemap</a></p>
<p class="text">Powered by <a href="#">Astro</a><span class="sep">&amp;</span><a href="#">Shirone</a></p>
</div>
</body></html>`;
	});

	/* ---------- 主题外观（site.yaml 主题键）---------- */
	const THEME_STYLES = [
		{ value: "tonalSpot", label: "tonalSpot · 经典柔和" },
		{ value: "vibrant", label: "vibrant · 鲜活" },
		{ value: "content", label: "content · 取自内容色" },
		{ value: "expressive", label: "expressive · 表现力" },
		{ value: "rainbow", label: "rainbow · 彩虹" },
		{ value: "fruitSalad", label: "fruitSalad · 水果沙拉" },
		{ value: "monochrome", label: "monochrome · 单色" },
		{ value: "neutral", label: "neutral · 中性" },
		{ value: "fidelity", label: "fidelity · 保真" },
	];
	const TEXTURE_PRESETS = [
		{ value: "none", label: "none · 无纹理" },
		{ value: "starlight", label: "starlight · 星光" },
		{ value: "cyber-dots", label: "cyber-dots · 赛博点阵" },
		{ value: "topography", label: "topography · 等高线" },
		{ value: "geometric", label: "geometric · 几何" },
		{ value: "sakura", label: "sakura · 樱花" },
	];
	const CAROUSEL_ANIMATIONS = [
		{ value: "ken-burns", label: "ken-burns · 缓慢推拉" },
		{ value: "zoom-in", label: "zoom-in · 放大" },
		{ value: "zoom-out", label: "zoom-out · 缩小" },
		{ value: "pan-left", label: "pan-left · 左移" },
		{ value: "pan-right", label: "pan-right · 右移" },
		{ value: "none", label: "none · 无动效" },
	];
	const DISPLAY_ITEMS = [
		{ key: "colorStyle", label: "配色风格选择器" },
		{ key: "colorSpec", label: "配色规范切换" },
		{ key: "wallpaperMode", label: "背景模式切换" },
		{ key: "layoutMode", label: "列表布局切换" },
		{ key: "reduceMotion", label: "减弱动效" },
		{ key: "texture", label: "背景纹理" },
	] as const;
	const LANG_OPTIONS = [
		{ value: "zh_CN", label: "简体中文" },
		{ value: "zh_TW", label: "繁體中文" },
		{ value: "en", label: "English" },
		{ value: "ja", label: "日本語" },
		{ value: "ko", label: "한국어" },
		{ value: "es", label: "Español" },
		{ value: "th", label: "ไทย" },
		{ value: "vi", label: "Tiếng Việt" },
		{ value: "tr", label: "Türkçe" },
		{ value: "id", label: "Bahasa Indonesia" },
	];

	const hue = ref(315);
	const fixed = ref(false);
	const style = ref("tonalSpot");
	const colorSpec = ref("2025");

	const defaultMode = ref("banner");
	const textureEnable = ref(true);
	const texturePreset = ref("starlight");
	const textureOpacity = ref(0.12);
	const allowMotion = ref(true);

	const desktopImages = ref<string[]>([]);
	const mobileImages = ref<string[]>([]);
	/* ---------- AI 推荐壁纸弹窗（桌面/移动各自一份，下载落仓后追加进对应列表）---------- */
	const desktopAiVisible = ref(false);
	const mobileAiVisible = ref(false);

	function appendDesktopBanner(src: string): void {
		desktopImages.value = [...desktopImages.value, src];
	}

	function appendMobileBanner(src: string): void {
		mobileImages.value = [...mobileImages.value, src];
	}
	const position = ref("center");
	const dimEnable = ref(true);
	const dimOpacity = ref(0.24);
	const homeTextEnable = ref(true);
	const homeTitle = ref("");
	const subtitles = ref<string[]>([]);
	const typeEnable = ref(true);
	const typeSpeed = ref(100);
	const typeDeleteSpeed = ref(50);
	const typePauseTime = ref(2000);
	const typeLoop = ref(true);
	const carouselEnable = ref(true);
	const carouselInterval = ref(6000);
	const fadeDuration = ref(1200);
	const animation = ref("ken-burns");
	const wavesEnable = ref(true);

	const display = ref<Record<string, boolean>>({});

	const i18nEnable = ref(false);
	const i18nLocales = ref<string[]>(["zh_CN"]);
	const siteLang = ref("zh_CN");

	const availableLangs = computed(() => LANG_OPTIONS.filter((l) => i18nLocales.value.includes(l.value)));

	watch(i18nLocales, (list) => {
		if (list.length > 0 && !list.includes(siteLang.value)) {
			siteLang.value = list[0];
		}
	});

	const palette = computed(() => [92, 74, 56, 40, 28].map((l) => `hsl(${hue.value}, 62%, ${l}%)`));

	async function loadAll(): Promise<void> {
		loading.value = true;
		try {
			const site = await settingsApi.getSite();
			siteForm.value = { title: site.title ?? "", subtitle: site.subtitle ?? "" };
			generalForm.value = { site: site.site ?? "", base: site.base ?? "", timeZone: site.timeZone ?? "" };
			favicons.value = (site.favicon ?? []).map((f) => ({ src: f.src, theme: f.theme }));
			themeFavicons.value = site.themeFavicon ?? [];
			faviconDraft.value = Object.fromEntries(
				FAVICON_THEMES.map((t) => [t.value, favicons.value.find((f) => f.theme === t.value)?.src ?? ""]),
			);

			hue.value = site.themeColor?.hue ?? 315;
			fixed.value = site.themeColor?.fixed ?? false;
			style.value = site.themeColor?.style ?? "tonalSpot";
			colorSpec.value = site.themeColor?.spec ?? "2025";

			defaultMode.value = site.wallpaperMode?.defaultMode ?? "banner";
			textureEnable.value = site.texture?.enable ?? true;
			texturePreset.value = site.texture?.defaultPreset ?? "starlight";
			textureOpacity.value = site.texture?.defaultOpacity ?? 0.12;
			allowMotion.value = site.texture?.allowMotion ?? true;

			desktopImages.value = site.banner?.src?.desktop ?? [];
			mobileImages.value = site.banner?.src?.mobile ?? [];
			position.value = site.banner?.position ?? "center";
			dimEnable.value = site.banner?.dim?.enable ?? true;
			dimOpacity.value = site.banner?.dim?.opacity ?? 0.24;
			homeTextEnable.value = site.banner?.homeText?.enable ?? true;
			homeTitle.value = site.banner?.homeText?.title ?? "";
			subtitles.value = site.banner?.homeText?.subtitle ?? [];
			const tw = site.banner?.homeText?.typewriter;
			typeEnable.value = tw?.enable ?? true;
			typeSpeed.value = tw?.speed ?? 100;
			typeDeleteSpeed.value = tw?.deleteSpeed ?? 50;
			typePauseTime.value = tw?.pauseTime ?? 2000;
			typeLoop.value = tw?.loop ?? true;
			const ca = site.banner?.carousel;
			carouselEnable.value = ca?.enable ?? true;
			carouselInterval.value = ca?.interval ?? 6000;
			fadeDuration.value = ca?.fadeDuration ?? 1200;
			animation.value = ca?.animation ?? "ken-burns";
			wavesEnable.value = site.banner?.waves?.enable ?? true;

			display.value = { ...(site.displaySettings ?? {}) };

			i18nEnable.value = site.i18n?.enable ?? false;
			i18nLocales.value = site.i18n?.locales?.length ? [...site.i18n.locales] : ["zh_CN"];
			siteLang.value = site.lang ?? "zh_CN";

			const profile = await settingsApi.getProfile();
			profileForm.value = {
				avatar: profile.avatar ?? "",
				name: profile.name ?? "",
				bio: profile.bio ?? "",
			};
			avatarDraft.value = profileForm.value.avatar;
			profileLinks.value = (profile.links ?? []).map((l) => ({ name: l.name, icon: l.icon, url: l.url }));

			const footer = await settingsApi.getFooter();
			footerEnable.value = Boolean(footer.enable);
			footerHtml.value = footer.html ?? "";
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loading.value = false;
		}
		// 图片库独立加载：settings 任一请求失败也不拖垮它
		void loadFooterLib();
	}

	async function save<T>(action: () => Promise<T>, tip = "已保存"): Promise<void> {
		saving.value = true;
		try {
			await action();
			ElMessage.success(tip);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			saving.value = false;
		}
	}

	/* ---------- 主题外观分区保存（site.yaml 各主题键独立落盘）---------- */
	async function saveThemeColor(): Promise<void> {
		await save(
			() => settingsApi.saveSite({ themeColor: { hue: hue.value, fixed: fixed.value, style: style.value, spec: colorSpec.value } }),
			"主题配色已保存",
		);
	}

	async function saveWallpaper(): Promise<void> {
		await save(
			() =>
				settingsApi.saveSite({
					wallpaperMode: { defaultMode: defaultMode.value },
					texture: {
						enable: textureEnable.value,
						defaultPreset: texturePreset.value,
						defaultOpacity: textureOpacity.value,
						allowMotion: allowMotion.value,
					},
				}),
			"壁纸与纹理已保存",
		);
	}

	async function saveBanner(): Promise<void> {
		await save(
			() =>
				settingsApi.saveSite({
					banner: {
						src: { desktop: desktopImages.value, mobile: mobileImages.value },
						position: position.value,
						dim: { enable: dimEnable.value, opacity: dimOpacity.value },
						homeText: {
							enable: homeTextEnable.value,
							title: homeTitle.value,
							subtitle: subtitles.value.filter((s) => s.trim()),
							typewriter: {
								enable: typeEnable.value,
								speed: typeSpeed.value,
								deleteSpeed: typeDeleteSpeed.value,
								pauseTime: typePauseTime.value,
								loop: typeLoop.value,
							},
						},
						carousel: {
							enable: carouselEnable.value,
							interval: carouselInterval.value,
							fadeDuration: fadeDuration.value,
							animation: animation.value,
						},
						waves: { enable: wavesEnable.value },
					},
				}),
			"横幅壁纸已保存",
		);
	}

	async function saveDisplay(): Promise<void> {
		await save(
			() => settingsApi.saveSite({ displaySettings: Object.fromEntries(DISPLAY_ITEMS.map((d) => [d.key, display.value[d.key] ?? true])) }),
			"访客显示面板已保存",
		);
	}

	async function saveI18n(): Promise<void> {
		if (i18nEnable.value && i18nLocales.value.length === 0) {
			ElMessage.warning("开放语言至少保留一种");
			return;
		}
		await save(
			() =>
				settingsApi.saveSite({
					lang: i18nEnable.value ? siteLang.value : "zh_CN",
					i18n: {
						enable: i18nEnable.value,
						locales: i18nLocales.value.length > 0 ? i18nLocales.value : ["zh_CN"],
					},
				}),
			"国际化设置已保存",
		);
	}

	/* ---------- 头像 / favicon 槽位：支持在线 URL，草稿确认后再生效并刷新预览 ---------- */
	/** 头像输入草稿：el-input 的 change 在回车或失焦时触发，此刻才写回表单值，预览随之重新加载 */
	const avatarDraft = ref("");

	function commitAvatarDraft(): void {
		profileForm.value.avatar = avatarDraft.value.trim();
	}

	function clearAvatar(): void {
		profileForm.value.avatar = "";
		avatarDraft.value = "";
	}

	/** 上传自动重命名并原位替换本地旧图（字段当前值指向头像目录时），表单显示相对路径 */
	async function uploadAvatar(options: UploadRequestOptions): Promise<void> {
		try {
			const r = await mediaApi.siteImage("avatar", options.file as File, { currentSrc: profileForm.value.avatar });
			profileForm.value.avatar = r.src;
			avatarDraft.value = r.src;
			options.onSuccess(r);
		} catch (e) {
			options.onError(e as unknown as Parameters<typeof options.onError>[0]);
			ElMessage.error((e as Error).message);
		}
	}

	/* ---------- favicon 预览自愈 ---------- */
	/** el-image 失败态粘滞：src 不变就永不重试，server 重启/HMR 窗口期挂一次就永久显示 ?
	 *  失败后延迟改写一次 src 查询参数，借组件内建的 src-watch 重载补拉，最多两次 */
	const faviconRetry = ref(new Map<string, number>());

	function faviconSrc(src: string): string {
		const url = previewUrlOf(src);
		if (!url) return "";
		const n = faviconRetry.value.get(url) ?? 0;
		return n > 0 ? `${url}${url.includes("?") ? "&" : "?"}retry=${n}` : url;
	}

	function retryFavicon(src: string): void {
		const url = previewUrlOf(src);
		if (!url) return;
		const n = faviconRetry.value.get(url) ?? 0;
		if (n >= 2) return;
		setTimeout(() => faviconRetry.value.set(url, n + 1), 1500);
	}

	/* ---------- favicon 槽位：浅色/深色各一张，可上传或填在线 URL ---------- */
	const FAVICON_THEMES = [
		{ value: "light", label: "浅色模式" },
		{ value: "dark", label: "深色模式" },
	] as const;

	/** 槽位当前配置值 */
	function faviconOf(theme: string): string | undefined {
		return favicons.value.find((f) => f.theme === theme)?.src || undefined;
	}

	/** 主题默认图标（取该主题尺寸最大一张），未配置槽位时展示当前生效值 */
	function themeDefaultOf(theme: string): string | undefined {
		const list = themeFavicons.value.filter((f) => f.theme === theme);
		return list.length ? list[list.length - 1].src : undefined;
	}

	/** 各槽位输入草稿（theme → src）：回车/失焦确认时写回槽位，空值 = 移除自定义 */
	const faviconDraft = ref<Record<string, string>>({});

	function commitFaviconDraft(theme: string): void {
		const v = (faviconDraft.value[theme] ?? "").trim();
		favicons.value = [...favicons.value.filter((f) => f.theme !== theme), ...(v ? [{ src: v, theme }] : [])];
	}

	/** 上传即按主题定名（favicon-light/dark.<ext>）原位替换旧文件；配置随「保存」落盘 */
	async function uploadFaviconSlot(theme: string, options: UploadRequestOptions): Promise<void> {
		try {
			const r = await mediaApi.siteImage("favicon", options.file as File, { name: `favicon-${theme}` });
			favicons.value = [...favicons.value.filter((f) => f.theme !== theme), { src: r.src, theme }];
			faviconDraft.value = { ...faviconDraft.value, [theme]: r.src };
			options.onSuccess(r);
		} catch (e) {
			options.onError(e as unknown as Parameters<typeof options.onError>[0]);
			ElMessage.error((e as Error).message);
		}
	}

	/** el-upload 的 http-request 适配（模板表达式里写不了带类型的箭头函数） */
	function faviconUploadRequest(theme: string): (options: UploadRequestOptions) => Promise<void> {
		return (options) => uploadFaviconSlot(theme, options);
	}

	function removeFavicon(theme: string): void {
		favicons.value = favicons.value.filter((f) => f.theme !== theme);
		faviconDraft.value = { ...faviconDraft.value, [theme]: "" };
	}

	/* ---------- 文案 AI（副标题/签名 ✨、打字机文案整组生成；AI 未启用不出现）---------- */

	const aiEnabled = ref(false);
	const typingGenerating = ref(false);

	/** 提取 AI 输出中的 JSON 字符串数组（剥围栏 + 截取中括号），失败返回空 */
	function parseTypewriterLines(content: string): string[] {
		const cleaned = content.replace(/```(?:json|JSON)?\s*\n?/g, "").replace(/```\s*$/g, "").trim();
		const start = cleaned.indexOf("[");
		const end = cleaned.lastIndexOf("]");
		if (start < 0 || end <= start) return [];
		try {
			const arr = JSON.parse(cleaned.slice(start, end + 1).replace(/,\s*([}\]])/g, "$1"));
			if (!Array.isArray(arr)) return [];
			return arr
				.filter((x): x is string => typeof x === "string")
				.map((s) => s.trim())
				.filter(Boolean)
				.slice(0, 6);
		} catch {
			return [];
		}
	}

	/** 基于站名/副标题/昵称/签名生成打字机轮播文案，确认后整体替换 */
	async function generateTypewriter(): Promise<void> {
		if (typingGenerating.value) return;
		typingGenerating.value = true;
		try {
			const ctx = [
				siteForm.value.title ? `站名：${siteForm.value.title}` : "",
				siteForm.value.subtitle ? `副标题：${siteForm.value.subtitle}` : "",
				profileForm.value.name ? `博主昵称：${profileForm.value.name}` : "",
				profileForm.value.bio ? `签名：${profileForm.value.bio}` : "",
			]
				.filter(Boolean)
				.join("；");
			const r = await aiApi.chat(
				[
					{
						role: "system",
						content: "你是博客文案助手。只输出一个 JSON 字符串数组，不要解释或代码围栏。",
					},
					{
						role: "user",
						content:
							`为博客首页打字机轮播生成 4-6 句短文案，每句 6-16 字，风格呼应站点气质，句间有变化。` +
							`站点信息：${ctx || "（未填写，按文艺技术博客风格发挥）"}\n` +
							`只输出 JSON 数组，形如 ["…","…"]。`,
					},
				],
				512,
				{ fast: true },
			);
			const lines = parseTypewriterLines(r.content);
			if (lines.length === 0) {
				ElMessage.warning("AI 输出无法解析，请重试");
				return;
			}
			await ElMessageBox.confirm(
				`将用 ${lines.length} 句新文案整体替换现有 ${subtitles.value.length} 句：\n${lines.map((l) => `· ${l}`).join("\n")}`,
				"AI生成打字机文案",
				{ confirmButtonText: "替换", cancelButtonText: "取消" },
			);
			subtitles.value = lines;
			ElMessage.success("已替换，记得保存横幅设置");
		} catch (e) {
			// ElMessageBox 取分/关闭属正常操作，静默；其余报错
			if (e === "cancel" || e === "close") return;
			ElMessage.error((e as Error).message);
		} finally {
			typingGenerating.value = false;
		}
	}

	onMounted(() => {
		loadAll();
		// AI 是否启用只读一次：控制文案 AI 入口
		aiApi
			.getSettings()
			.then((s) => (aiEnabled.value = s.enable))
			.catch(() => {});
	});
</script>

<template>
	<div v-loading="loading" class="settings">
		<el-card class="page-card form-col">
			<el-tabs v-model="tab" class="settings-tabs">
				<el-tab-pane label="基础信息" name="basic">
					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>站点信息</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="save(() => settingsApi.saveSite({ ...siteForm }))">保存</el-button>
						</header>
						<el-form label-position="top" class="form-grid">
							<el-form-item label="站名">
								<el-input v-model="siteForm.title" />
							</el-form-item>
							<el-form-item label="副标题">
								<AiTextInput
									v-model="siteForm.subtitle"
									:context="`站点副标题（站名：${siteForm.title || '未填写'}）`"
									:ai="aiEnabled"
								/>
							</el-form-item>
						</el-form>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>个人资料</h3>
							</div>
							<el-button
								type="primary"
								:loading="saving"
								@click="save(() => settingsApi.saveProfile({ ...profileForm, links: profileLinks.filter((l) => l.name && l.url) }))"
							>
								保存
							</el-button>
						</header>
						<div class="avatar-row">
							<el-avatar :size="72" :src="previewUrlOf(profileForm.avatar)">
								<el-icon :size="28"><User /></el-icon>
							</el-avatar>
							<div class="avatar-fields">
								<el-input
									v-model="avatarDraft"
									placeholder="在线 URL（https://…）或本地上传后的相对路径"
									clearable
									@change="commitAvatarDraft"
									@clear="clearAvatar"
								>
									<template #suffix><el-icon class="avatar-url-icon"><Link /></el-icon></template>
								</el-input>
								<div class="avatar-ops">
									<el-upload :show-file-list="false" :http-request="uploadAvatar" accept=".webp,.png,.jpg,.jpeg,.gif,.avif">
										<el-button plain>
											<el-icon><Upload /></el-icon>{{ profileForm.avatar ? "更换头像" : "上传头像" }}
										</el-button>
									</el-upload>
									<el-button v-if="profileForm.avatar" text type="danger" @click="clearAvatar">移除</el-button>
									<span class="muted avatar-hint">回车或失焦确认后预览即时刷新</span>
								</div>
							</div>
						</div>
						<el-form label-position="top" class="form-grid">
							<el-form-item label="昵称">
								<el-input v-model="profileForm.name" />
							</el-form-item>
							<el-form-item label="签名">
								<AiTextInput
									v-model="profileForm.bio"
									:context="`博主签名（昵称：${profileForm.name || '未填写'}）`"
									:ai="aiEnabled"
								/>
							</el-form-item>
						</el-form>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>社交链接</h3>
							</div>
							<el-button plain @click="profileLinks.push({ name: '', icon: '', url: '' })">添加链接</el-button>
						</header>
						<div v-for="(l, i) in profileLinks" :key="i" class="row">
							<el-input v-model="l.name" placeholder="名称" style="width: 140px" />
							<el-input v-model="l.icon" placeholder="fa6-brands:github" style="width: 220px" />
							<el-input v-model="l.url" placeholder="https://…" class="grow" />
							<el-button circle type="danger" plain size="small" @click="profileLinks.splice(i, 1)">
								<el-icon><Close /></el-icon>
							</el-button>
						</div>
						<p v-if="!profileLinks.length" class="muted empty-tip">暂无链接</p>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>站点图标 favicon</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="save(() => settingsApi.saveSite({ favicon: favicons.filter((f) => f.src) }))">保存</el-button>
						</header>
						<div class="favicon-slots">
							<div v-for="t in FAVICON_THEMES" :key="t.value" class="favicon-slot">
								<div class="favicon-slot-head">
									<span>{{ t.label }}</span>
									<el-tag v-if="faviconOf(t.value)" size="small" effect="plain">自定义</el-tag>
									<el-tag v-else size="small" type="info" effect="plain">主题默认</el-tag>
								</div>
								<div class="favicon-slot-body">
									<el-image
										v-if="faviconOf(t.value)"
										:src="faviconSrc(faviconOf(t.value)!)"
										fit="cover"
										class="favicon-img"
										@error="retryFavicon(faviconOf(t.value)!)"
									>
										<template #error><div class="favicon-fallback">?</div></template>
									</el-image>
									<el-image
										v-else-if="themeDefaultOf(t.value)"
										:src="faviconSrc(themeDefaultOf(t.value)!)"
										fit="cover"
										class="favicon-img is-default"
										title="当前生效：主题默认图标"
										@error="retryFavicon(themeDefaultOf(t.value)!)"
									>
										<template #error><div class="favicon-fallback">?</div></template>
									</el-image>
									<div v-else class="favicon-img is-none"><el-icon><PictureFilled /></el-icon></div>
									<div class="favicon-slot-ops">
										<el-upload
											:show-file-list="false"
											:http-request="faviconUploadRequest(t.value)"
											accept=".webp,.png,.jpg,.jpeg,.gif,.avif,.ico,.svg"
										>
											<el-button plain size="small">
												<el-icon><Upload /></el-icon>{{ faviconOf(t.value) ? "更换" : "上传" }}
											</el-button>
										</el-upload>
										<el-button
											v-if="faviconOf(t.value)"
											size="small"
											text
											type="danger"
											@click="removeFavicon(t.value)"
										>
											移除
										</el-button>
									</div>
								</div>
								<el-input
									v-model="faviconDraft[t.value]"
									size="small"
									class="favicon-src-input"
									placeholder="上传自动定名，或直接填 https://…（留空用主题默认）"
									@change="commitFaviconDraft(t.value)"
								/>
							</div>
						</div>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>常规设置</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="save(() => settingsApi.saveSite({ ...generalForm }))">保存</el-button>
						</header>
						<el-form label-position="top" class="form-grid">
							<el-form-item label="站点地址">
								<el-input v-model="generalForm.site" placeholder="https://blogs.example.com/（以斜杠结尾）" />
							</el-form-item>
							<el-form-item label="子路径">
								<el-input v-model="generalForm.base" placeholder="部署在根目录填 /" />
							</el-form-item>
							<el-form-item label="时区">
								<el-select
									v-model="generalForm.timeZone"
									filterable
									allow-create
									default-first-option
									placeholder="选择时区，如 Asia/Shanghai"
									class="tz-select"
								>
									<el-option v-for="t in TIMEZONE_OPTIONS" :key="t.value" :value="t.value" :label="t.label" />
								</el-select>
							</el-form-item>
						</el-form>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>访客显示面板</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="saveDisplay">保存</el-button>
						</header>
						<div class="display-grid">
							<div v-for="d in DISPLAY_ITEMS" :key="d.key" class="display-item">
								<el-switch v-model="display[d.key]" />
								<span>{{ d.label }}</span>
							</div>
						</div>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>国际化</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="saveI18n">保存</el-button>
						</header>
						<el-form label-width="130px" class="form-narrow">
							<el-form-item label="启用国际化">
								<el-switch v-model="i18nEnable" />
								<span class="muted form-hint">关闭时全站锁定简体中文（zh_CN）</span>
							</el-form-item>
							<template v-if="i18nEnable">
								<el-form-item label="开放语言">
									<div>
										<el-checkbox-group v-model="i18nLocales" class="locale-group">
											<el-checkbox v-for="l in LANG_OPTIONS" :key="l.value" :value="l.value">
												{{ l.label }}
											</el-checkbox>
										</el-checkbox-group>
									</div>
								</el-form-item>
								<el-form-item label="站点语言">
									<el-select v-model="siteLang" style="width: 260px">
										<el-option v-for="l in availableLangs" :key="l.value" :value="l.value" :label="l.label" />
									</el-select>
								</el-form-item>
							</template>
						</el-form>
						<el-alert
							type="info"
							:closable="false"
							title="语言切换只作用于界面文案，文章内容不随语言翻译"
							class="i18n-tip"
						/>
					</section>
				</el-tab-pane>

				<el-tab-pane label="页脚" name="footer">
					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>自定义页脚</h3>
								<p class="muted">开启后注入版权行上方（如备案号）</p>
							</div>
							<el-button type="primary" :loading="saving" @click="save(() => settingsApi.saveFooter({ enable: footerEnable, html: footerHtml }))">保存</el-button>
						</header>
						<el-form label-position="top">
							<el-form-item label="启用注入">
								<el-switch v-model="footerEnable" />
							</el-form-item>
						</el-form>
						<div class="footer-toolbar">
							<el-button :loading="formatting" @click="formatFooterHtml">
								<el-icon><MagicStick /></el-icon>格式化
							</el-button>
						</div>
						<HtmlCodeEditor
							v-model="footerHtml"
							class="footer-editor"
							height="300px"
							placeholder="页脚 HTML 片段，可含 <style> 与 <img>"
						/>
						<div class="footer-imgs-head">
							<span>图片库（复制路径粘进内容）</span>
							<div class="footer-lib-ops">
								<el-input
									v-model="footerUrl"
									placeholder="在线图片直链"
									clearable
									class="footer-lib-url"
									@keyup.enter="importFooterImage"
								/>
								<el-button
									size="small"
									:loading="footerImporting"
									:disabled="!footerUrlValid"
									@click="importFooterImage"
								>
									<el-icon><Link /></el-icon>在线导入
								</el-button>
								<el-upload
									:show-file-list="false"
									:http-request="uploadFooterImage"
									accept=".webp,.png,.jpg,.jpeg,.gif,.avif"
								>
									<el-button size="small">
										<el-icon><PictureFilled /></el-icon>上传图片
									</el-button>
								</el-upload>
							</div>
						</div>
						<div class="footer-imgs">
							<div v-for="img in footerLib" :key="img.src" class="footer-img-item">
								<el-image
									:src="img.previewUrl"
									fit="cover"
									class="footer-img-thumb"
									:preview-src-list="[img.previewUrl]"
									preview-teleported
								>
									<template #error>
										<div class="footer-img-fallback"><el-icon><PictureFilled /></el-icon></div>
									</template>
								</el-image>
								<div class="footer-img-meta">
									<span class="footer-img-src" :title="img.src">{{ img.src }}</span>
								</div>
								<span class="footer-img-repo" :title="footerRepoPath(img.src)">{{ footerRepoPath(img.src) }}</span>
								<el-button size="small" plain @click="copyFooterImgSrc(img.src)">复制路径</el-button>
							</div>
							<p v-if="!footerLib.length" class="footer-lib-empty">暂无图片</p>
						</div>
						<el-divider content-position="left">预览</el-divider>
						<iframe class="footer-preview" :srcdoc="footerPreviewDoc" sandbox=""></iframe>
					</section>
				</el-tab-pane>

				<el-tab-pane label="主题外观" name="appearance">
					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>主题配色</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="saveThemeColor">保存</el-button>
						</header>
						<div class="hue-row">
							<el-slider v-model="hue" :min="0" :max="360" :step="1" class="hue-slider" />
							<el-input-number v-model="hue" :min="0" :max="360" :step="1" size="small" style="width: 110px" />
						</div>
						<div class="palette">
							<div v-for="(c, i) in palette" :key="i" class="palette-chip" :style="{ background: c }" />
						</div>
						<el-form label-width="130px" class="form-narrow">
							<el-form-item label="配色风格">
								<el-select v-model="style" style="width: 260px">
									<el-option v-for="s in THEME_STYLES" :key="s.value" :value="s.value" :label="s.label" />
								</el-select>
							</el-form-item>
							<el-form-item label="规范版本">
								<el-radio-group v-model="colorSpec">
									<el-radio-button value="2025">2025（Material 3 Expressive）</el-radio-button>
									<el-radio-button value="2021">2021</el-radio-button>
								</el-radio-group>
							</el-form-item>
							<el-form-item label="固定色相">
								<el-switch v-model="fixed" />
								<span class="muted form-hint">开启后前台访客不可调色</span>
							</el-form-item>
						</el-form>
					</section>

					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>壁纸与纹理</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="saveWallpaper">保存</el-button>
						</header>
						<el-form label-width="130px" class="form-narrow">
							<el-form-item label="背景模式">
								<el-radio-group v-model="defaultMode">
									<el-radio-button value="banner">横幅壁纸</el-radio-button>
									<el-radio-button value="none">纯色背景</el-radio-button>
								</el-radio-group>
							</el-form-item>
							<el-form-item label="纹理系统">
								<el-switch v-model="textureEnable" />
							</el-form-item>
							<template v-if="textureEnable">
								<el-form-item label="默认纹理">
									<el-select v-model="texturePreset" style="width: 260px">
										<el-option v-for="t in TEXTURE_PRESETS" :key="t.value" :value="t.value" :label="t.label" />
									</el-select>
								</el-form-item>
								<el-form-item label="纹理浓度">
									<el-slider v-model="textureOpacity" :min="0.05" :max="0.25" :step="0.01" style="width: 260px" />
								</el-form-item>
								<el-form-item label="背景微动效">
									<el-switch v-model="allowMotion" />
								</el-form-item>
							</template>
						</el-form>
					</section>
				</el-tab-pane>

				<el-tab-pane label="横幅壁纸" name="banner">
					<section class="sec">
						<header class="sec-head">
							<div>
								<h3>横幅壁纸</h3>
							</div>
							<el-button type="primary" :loading="saving" @click="saveBanner">保存</el-button>
						</header>
						<div class="banner-group-label">
							<span>桌面端壁纸（src.desktop，多张自动轮播）</span>
							<el-button plain @click="desktopAiVisible = true">
								<el-icon><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 推荐
							</el-button>
						</div>
						<SiteImageUpload v-model="desktopImages" target="banner-desktop" />
						<div class="banner-group-label">
							<span>移动端壁纸（src.mobile）</span>
							<el-button plain @click="mobileAiVisible = true">
								<el-icon><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 推荐
							</el-button>
						</div>
						<SiteImageUpload v-model="mobileImages" target="banner-mobile" />
						<p class="muted banner-drag-hint">列表内拖动缩略图排序；删除须保存后生效</p>
						<WallpaperRecommendDialog
							v-model="desktopAiVisible"
							target="banner-desktop"
							@applied="appendDesktopBanner"
						/>
						<WallpaperRecommendDialog
							v-model="mobileAiVisible"
							target="banner-mobile"
							@applied="appendMobileBanner"
						/>

						<el-form label-width="130px" class="form-narrow banner-form">
							<el-form-item label="裁切焦点">
								<el-radio-group v-model="position">
									<el-radio-button value="top">顶部</el-radio-button>
									<el-radio-button value="center">居中</el-radio-button>
									<el-radio-button value="bottom">底部</el-radio-button>
								</el-radio-group>
							</el-form-item>
							<el-form-item label="暗化遮罩">
								<el-switch v-model="dimEnable" />
								<el-slider
									v-if="dimEnable"
									v-model="dimOpacity"
									:min="0"
									:max="1"
									:step="0.02"
									style="width: 220px; margin-left: 16px"
								/>
							</el-form-item>
							<el-form-item label="底部波浪">
								<el-switch v-model="wavesEnable" />
							</el-form-item>
						</el-form>

						<el-divider content-position="left">首页横幅文字</el-divider>
						<el-form label-width="130px" class="form-narrow">
							<el-form-item label="启用">
								<el-switch v-model="homeTextEnable" />
							</el-form-item>
							<template v-if="homeTextEnable">
								<el-form-item label="主标题">
									<el-input v-model="homeTitle" style="width: 300px" />
								</el-form-item>
								<el-form-item label="打字机文案">
									<div class="subtitle-list">
										<div v-for="(_, i) in subtitles" :key="i" class="subtitle-row">
											<el-input v-model="subtitles[i]" :placeholder="`第 ${i + 1} 句`" />
											<el-button circle type="danger" plain size="small" @click="subtitles.splice(i, 1)">
												<el-icon><Close /></el-icon>
											</el-button>
										</div>
										<div class="subtitle-ops">
											<el-button plain size="small" @click="subtitles.push('')">
												<el-icon><Plus /></el-icon>加一句
											</el-button>
											<el-button
												v-if="aiEnabled"
												plain
												size="small"
												:loading="typingGenerating"
												@click="generateTypewriter"
											>
												<el-icon v-if="!typingGenerating"><Icon icon="material-symbols:auto-awesome" /></el-icon>AI生成文案
											</el-button>
										</div>
									</div>
								</el-form-item>
								<el-form-item label="打字机动效">
									<el-switch v-model="typeEnable" />
								</el-form-item>
								<template v-if="typeEnable">
									<el-form-item label="键入间隔">
										<el-input-number v-model="typeSpeed" :min="10" :step="10" /> <span class="muted form-hint">毫秒/字</span>
									</el-form-item>
									<el-form-item label="删除间隔">
										<el-input-number v-model="typeDeleteSpeed" :min="10" :step="10" /> <span class="muted form-hint">毫秒/字</span>
									</el-form-item>
									<el-form-item label="停留时长">
										<el-input-number v-model="typePauseTime" :min="0" :step="500" /> <span class="muted form-hint">毫秒</span>
									</el-form-item>
									<el-form-item label="循环播放">
										<el-switch v-model="typeLoop" />
									</el-form-item>
								</template>
							</template>
						</el-form>

						<el-divider content-position="left">多图轮播</el-divider>
						<el-form label-width="130px" class="form-narrow">
							<el-form-item label="自动轮播">
								<el-switch v-model="carouselEnable" />
							</el-form-item>
							<template v-if="carouselEnable">
								<el-form-item label="切换间隔">
									<el-input-number v-model="carouselInterval" :min="3000" :step="500" /> <span class="muted form-hint">毫秒</span>
								</el-form-item>
								<el-form-item label="过渡时长">
									<el-input-number v-model="fadeDuration" :min="0" :step="100" /> <span class="muted form-hint">毫秒</span>
								</el-form-item>
								<el-form-item label="运镜动效">
									<el-select v-model="animation" style="width: 260px">
										<el-option v-for="a in CAROUSEL_ANIMATIONS" :key="a.value" :value="a.value" :label="a.label" />
									</el-select>
								</el-form-item>
							</template>
						</el-form>
					</section>
				</el-tab-pane>
			</el-tabs>
		</el-card>

		<el-card class="preview-col">
			<PreviewPanel autostart frame-height="100%" title="站点预览" />
		</el-card>
	</div>
</template>

<style scoped>
	.settings {
		height: 100%;
		display: flex;
		gap: 14px;
		align-items: stretch;
	}
	/* 左栏：设置表单，占 1/3，超高自身滚动 */
	.settings > .form-col {
		flex: 0 0 33%;
		min-width: 420px;
	}
	/* 右栏：真站预览常驻，所有 tab 通用 */
	.preview-col {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-col > :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 0;
	}
	.preview-col :deep(.panel) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-col :deep(.frame-wrap) {
		flex: 1;
		min-height: 0;
	}
	.settings-tabs {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.settings-tabs :deep(.el-tabs__content) {
		flex: 1;
		overflow-y: auto;
		padding-right: 6px;
	}
	.settings-tabs :deep(.el-tab-pane) {
		display: flex;
		flex-direction: column;
	}
	/* 分区：内嵌面板 */
	.sec {
		background: rgba(255, 255, 255, 0.36);
		border: 1px solid var(--hairline);
		border-radius: 14px;
		padding: 16px 18px 18px;
		margin-bottom: 14px;
	}
	.sec-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 14px;
	}
	.sec-head h3 {
		margin: 0;
		font-size: 20px;
		font-weight: 650;
	}
	.sec-head p {
		margin: 2px 0 0;
		font-size: 20px;
	}
	.head-actions {
		display: flex;
		gap: 8px;
		align-items: center;
		flex: none;
	}
	/* 表单：label 置顶 + 响应式两列网格 */
	.form-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
		column-gap: 18px;
		max-width: 820px;
	}
	.form-hint {
		margin-left: 10px;
		font-size: 20px;
		white-space: nowrap;
	}
	/* 通用编辑行 */
	.row {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-bottom: 8px;
	}
	.empty-tip {
		font-size: 20px;
		padding: 6px 0;
		margin: 0;
	}
	/* favicon 槽位：浅色/深色各一张 */
	.favicon-slots {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}
	.favicon-slot {
		flex: 1;
		min-width: 250px;
		max-width: 330px;
		border: 1px solid var(--hairline);
		border-radius: 12px;
		padding: 10px 12px;
		background: rgba(255, 255, 255, 0.4);
	}
	.favicon-slot-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: 8px;
		font-size: 20px;
		font-weight: 600;
	}
	.favicon-slot-body {
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.favicon-img {
		width: 44px;
		height: 44px;
		border-radius: 10px;
		border: 1px solid var(--glass-border-soft);
		background: #fff;
		flex: none;
	}
	/* 未配置槽位回显的主题默认图标：弱化提示「当前生效值」 */
	.favicon-img.is-default {
		opacity: 0.72;
	}
	.favicon-img.is-none {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.12);
		color: var(--text-sub);
	}
	.favicon-slot-ops {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
	}
	.favicon-src-input {
		margin-top: 8px;
	}
	.favicon-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-sub);
		font-size: 20px;
	}
	.tz-select {
		max-width: 460px;
	}
	.avatar-row {
		display: flex;
		gap: 14px;
		align-items: center;
		margin-bottom: 16px;
		max-width: 640px;
	}
	/* 头像：URL/相对路径可编辑输入 + 上传按钮 */
	.avatar-fields {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.avatar-url-icon {
		color: var(--text-sub);
	}
	.avatar-ops {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.avatar-hint {
		font-size: 20px;
	}
	.banner-drag-hint {
		font-size: 20px;
		margin: 8px 0 0;
	}
	.i18n-tip {
		margin-top: 4px;
	}
	.i18n-tip :deep(.el-alert__title) {
		font-size: 20px;
	}
	.footer-toolbar {
		display: flex;
		gap: 8px;
		margin-bottom: 10px;
	}
	.footer-editor {
		max-width: 900px;
	}
	.footer-imgs-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		max-width: 900px;
		margin: 14px 0 8px;
		font-size: 20px;
		color: var(--text-sub);
	}
	.footer-lib-ops {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.footer-lib-url {
		width: 240px;
	}
	.footer-imgs {
		display: flex;
		flex-wrap: wrap;
		gap: 12px;
		max-width: 900px;
	}
	.footer-img-item {
		display: flex;
		flex-direction: column;
		gap: 6px;
		width: 168px;
	}
	.footer-img-thumb {
		width: 168px;
		height: 96px;
		border-radius: 10px;
		border: 1px solid var(--glass-border-soft);
	}
	.footer-img-fallback {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.12);
		color: var(--text-sub);
	}
	.footer-img-meta {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.footer-img-src {
		flex: 1;
		min-width: 0;
		font-size: 20px;
		color: var(--text-sub);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.footer-img-repo {
		font-size: 20px;
		color: var(--el-text-color-secondary);
		opacity: 0.75;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.footer-lib-empty {
		margin: 0;
		font-size: 20px;
		color: var(--text-sub);
	}
	.footer-preview {
		width: 100%;
		height: 260px;
		border: 1px solid var(--glass-border-soft);
		border-radius: 12px;
		background: #fff;
	}

	/* ---------- 主题外观表单 ---------- */
	.form-narrow {
		max-width: 680px;
	}
	.hue-row {
		display: flex;
		align-items: center;
		gap: 14px;
		margin-bottom: 10px;
	}
	.hue-slider {
		width: 320px;
	}
	.hue-slider :deep(.el-slider__runway) {
		background: linear-gradient(
			to right,
			hsl(0, 62%, 60%),
			hsl(60, 62%, 60%),
			hsl(120, 62%, 60%),
			hsl(180, 62%, 60%),
			hsl(240, 62%, 60%),
			hsl(300, 62%, 60%),
			hsl(360, 62%, 60%)
		);
	}
	.palette {
		display: flex;
		gap: 8px;
		margin-bottom: 16px;
	}
	.palette-chip {
		width: 46px;
		height: 28px;
		border-radius: 8px;
		border: 1px solid var(--glass-border-soft);
		box-shadow: var(--glass-shadow);
	}
	.banner-group-label {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-weight: 600;
		margin: 6px 0 8px;
	}
	.banner-form {
		margin-top: 16px;
	}
	.subtitle-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
		max-width: 520px;
	}
	.subtitle-ops {
		display: flex;
		gap: 8px;
	}
	.subtitle-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.display-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 18px;
	}
	.display-item {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.locale-group {
		display: flex;
		flex-wrap: wrap;
		gap: 4px 18px;
	}
</style>
