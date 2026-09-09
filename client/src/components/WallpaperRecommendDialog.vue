<script setup lang="ts">
	import { computed, nextTick, reactive, ref, watch } from "vue";
	import { ElMessage } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { WallpaperCandidate } from "@shirone-admin/shared";
	import { aiApi, mediaApi } from "../api";

	/**
	 * AI 推荐壁纸：safebooru 二次元图源抓取候选，纯图墙展示（预览加载失败=疑似防盗链，直接不展示），
	 * 勾选后点「确认导入」统一下载落内容仓并 emit applied 由父级追加进列表。
	 */
	const visible = defineModel<boolean>({ default: false });
	const props = defineProps<{
		/** 落仓目标：banner-desktop | banner-mobile */
		target: string;
	}>();
	const emit = defineEmits<{ applied: [src: string] }>();

	const isMobile = computed(() => props.target === "banner-mobile");
	const kind = computed<"desktop" | "mobile">(() => (isMobile.value ? "mobile" : "desktop"));
	const dialogTitle = computed(() => `AI 推荐壁纸（${isMobile.value ? "移动端" : "桌面端"}）`);

	/** 预设主题：展示中文，检索用 safebooru 英文标签（输入框自由输入则原样作标签） */
	const PRESET_CHIPS: { label: string; tags: string }[] = [
		{ label: "星空", tags: "sky" },
		{ label: "山川湖海", tags: "scenery" },
		{ label: "森林晨雾", tags: "forest" },
		{ label: "城市夜景", tags: "cityscape" },
		{ label: "极简渐变", tags: "abstract" },
		{ label: "赛博朋克", tags: "cyberpunk" },
	];

	const query = ref("");
	/** 最近一次检索用的关键词（预设词条或输入框），「加载更多」沿用它继续翻批 */
	const lastTerms = ref("");
	const searching = ref(false);
	/** 追加加载（加载更多）：按钮自身转 loading，网格不出 v-loading 遮罩 */
	const loadingMore = ref(false);
	const searched = ref(false);
	const candidates = ref<WallpaperCandidate[]>([]);
	const gridEl = ref<HTMLElement | null>(null);

	/** 图片实测尺寸与加载失败标记 */
	const dims = reactive(new Map<string, { w: number; h: number }>());
	const probeFailed = reactive(new Set<string>());
	const checked = reactive(new Set<string>());
	const downloading = ref(false);

	/** 预览挂了（防盗链等）的不展示、不可选 */
	const shownCandidates = computed(() => candidates.value.filter((c) => !probeFailed.has(c.imageUrl)));
	const checkedCount = computed(() => checked.size);

	/** 再次检索在已有候选下方追加（按直链去重），滚动定位到新一批；more=走「加载更多」（按钮 loading，无遮罩） */
	async function doSearch(tags?: string, more = false): Promise<void> {
		const terms = (tags ?? query.value).trim();
		if (searching.value) return;
		lastTerms.value = terms;
		searching.value = true;
		loadingMore.value = more;
		try {
			const r = await aiApi.wallpaperSearch(terms, kind.value);
			const seen = new Set(candidates.value.map((c) => c.imageUrl));
			const fresh = r.candidates.filter((c) => !seen.has(c.imageUrl));
			const before = candidates.value.length;
			candidates.value = [...candidates.value, ...fresh];
			searched.value = true;
			if (fresh.length === 0 && before > 0) ElMessage.warning("没有新的候选");
			if (before > 0 && fresh.length > 0) {
				await nextTick();
				gridEl.value
					?.querySelector(`[data-url="${CSS.escape(fresh[0].imageUrl)}"]`)
					?.scrollIntoView({ block: "start", behavior: "smooth" });
			}
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			searching.value = false;
			loadingMore.value = false;
		}
	}

	function probe(url: string, e: Event): void {
		const img = e.target as HTMLImageElement;
		if (img.naturalWidth > 0) dims.set(url, { w: img.naturalWidth, h: img.naturalHeight });
	}

	function toggleCheck(url: string, v: boolean | string | number | undefined): void {
		if (v) checked.add(url);
		else checked.delete(url);
	}

	/** 实测宽高比是否适配目标端（横屏端要横图，竖屏端要竖图）；未探测完返回 undefined */
	function fitOf(url: string): boolean | undefined {
		const d = dims.get(url);
		if (!d) return undefined;
		return isMobile.value ? d.h / d.w >= 1.2 : d.w / d.h >= 1.2;
	}

	/** 勾选的统一下载落仓：全部成功才关弹窗，失败项保留勾选供重试 */
	async function confirmDownload(): Promise<void> {
		if (downloading.value || checked.size === 0) return;
		downloading.value = true;
		let ok = 0;
		let failed = 0;
		for (const url of [...checked]) {
			try {
				const r = await mediaApi.siteImageImport({ target: props.target, url });
				emit("applied", r.src);
				checked.delete(url);
				ok += 1;
			} catch {
				failed += 1;
			}
		}
		downloading.value = false;
		if (ok > 0) ElMessage.success(`已导入 ${ok} 张壁纸`);
		if (failed > 0) ElMessage.error(`${failed} 张导入失败，可重试`);
		else visible.value = false;
	}

	/** 关闭即清场，下次打开从零开始 */
	watch(visible, (v) => {
		if (v) return;
		candidates.value = [];
		searched.value = false;
		checked.clear();
		dims.clear();
		probeFailed.clear();
	});
</script>

<template>
	<el-dialog
		v-model="visible"
		:title="dialogTitle"
		width="1080px"
		align-center
		append-to-body
		:close-on-click-modal="false"
		class="wallpaper-dialog"
	>
		<div class="search-bar">
			<el-input
				v-model="query"
				placeholder="可选：主题标签，如 genshin、touhou"
				clearable
				@keydown.enter.prevent="doSearch()"
			/>
			<el-button type="primary" :loading="searching" @click="doSearch()">
				<el-icon v-if="!searching"><Icon icon="material-symbols:auto-awesome" /></el-icon>AI检索
			</el-button>
		</div>
		<div class="chip-row">
			<el-button v-for="c in PRESET_CHIPS" :key="c.label" size="small" plain @click="doSearch(c.tags)">
				{{ c.label }}
			</el-button>
		</div>

		<div ref="gridEl" v-loading="searching && !loadingMore" class="wp-grid" :class="{ portrait: isMobile }">
			<div v-for="c in shownCandidates" :key="c.imageUrl" class="wp-card" :data-url="c.imageUrl">
				<div class="wp-thumb">
					<img
						:src="c.previewUrl ?? c.imageUrl"
						alt=""
						referrerpolicy="no-referrer"
						@load="probe(c.imageUrl, $event)"
						@error="probeFailed.add(c.imageUrl)"
					/>
					<el-tag v-if="fitOf(c.imageUrl) === false" size="small" type="info" class="wp-unfit" disable-transitions>
						比例不符
					</el-tag>
					<el-checkbox
						class="wp-check"
						:model-value="checked.has(c.imageUrl)"
						@change="toggleCheck(c.imageUrl, $event)"
					/>
				</div>
			</div>
			<el-empty
				v-if="!searching && searched && shownCandidates.length === 0"
				description="未检索到候选，换个关键词试试"
				:image-size="72"
				class="wp-empty"
			/>
			<el-empty v-else-if="!searching && !searched" :image-size="72" class="wp-empty" />
			<div v-if="shownCandidates.length > 0 && (!searching || loadingMore)" class="wp-more">
				<el-button plain :loading="loadingMore" @click="doSearch(lastTerms, true)">加载更多</el-button>
			</div>
		</div>

		<template #footer>
			<el-button type="primary" :loading="downloading" :disabled="checkedCount === 0" @click="confirmDownload">
				{{ downloading ? "导入中…" : checkedCount > 0 ? `确认导入（${checkedCount}）` : "确认导入" }}
			</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
	:global(.wallpaper-dialog) {
		height: 84vh;
		display: flex;
		flex-direction: column;
	}
	:global(.wallpaper-dialog .el-dialog__body) {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overflow-x: hidden;
	}
	.search-bar {
		display: flex;
		gap: 10px;
		flex-shrink: 0;
	}
	.chip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		margin-top: 10px;
		flex-shrink: 0;
	}
	.wp-grid {
		display: flex;
		flex-wrap: wrap;
		gap: 14px;
		margin-top: 14px;
		min-height: 240px;
		flex: 1;
		align-content: flex-start;
	}
	.wp-card {
		width: calc((100% - 42px) / 4);
		border: 1px solid var(--glass-border-soft);
		border-radius: 12px;
		overflow: hidden;
		background: var(--el-fill-color-light);
	}
	.wp-thumb {
		position: relative;
		aspect-ratio: 16 / 10;
	}
	.wp-grid.portrait .wp-thumb {
		aspect-ratio: 9 / 15;
	}
	.wp-thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		display: block;
	}
	.wp-unfit {
		position: absolute;
		top: 8px;
		left: 8px;
	}
	.wp-check {
		position: absolute;
		top: 8px;
		right: 8px;
		height: auto;
	}
	.wp-check :deep(.el-checkbox__inner) {
		width: 24px;
		height: 24px;
		border-radius: 6px;
		border: 2px solid rgba(255, 255, 255, 0.9);
		background: rgba(255, 255, 255, 0.25);
		backdrop-filter: blur(2px);
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
	}
	/* 选中态：紫色实底填充（压过上面的半透明白底） */
	.wp-check :deep(.el-checkbox__input.is-checked .el-checkbox__inner) {
		background: var(--accent-b, #a855f7);
		border-color: #fff;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
	}
	/* 对勾弃用 EP 旋转边框画法，改为铺满白底 + SVG mask 粗描边：绝对居中且粗细可控 */
	.wp-check :deep(.el-checkbox__input.is-checked .el-checkbox__inner::after) {
		left: 0;
		top: 0;
		width: 100%;
		height: 100%;
		border: none;
		transform: none;
		background: #fff;
		-webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.6 4.6L19 7.5' fill='none' stroke='black' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
			center / 80% no-repeat;
		mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 12.5l4.6 4.6L19 7.5' fill='none' stroke='black' stroke-width='3.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
			center / 80% no-repeat;
	}
	.wp-more {
		width: 100%;
		display: flex;
		justify-content: center;
		margin-top: 4px;
	}
	.wp-empty {
		width: 100%;
	}
	.wp-grid:has(> .wp-empty) {
		align-content: center;
	}
</style>
