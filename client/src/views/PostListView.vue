<script setup lang="ts">
	import { computed, nextTick, onMounted, ref, watch } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { MdPreview } from "md-editor-v3";
	import type { NavBarLink, PostFile, PostMeta } from "@shirone-admin/shared";
	import { postApi, settingsApi, taxonomyApi } from "../api";
	import { localMediaSanitize, postPreviewBody } from "../utils/content-media";
	import {
		NAV_DROP_MIME,
		NAV_PRESETS,
		POST_DROP_MIME,
		UNCATEGORIZED,
		navPresetShort,
	} from "../utils/navPresets";
	import { categoryCardStyle, tagColorStyle } from "../utils/tagColor";
	import DataIcon from "../components/DataIcon.vue";
	import NavBarLinksEditor from "../components/NavBarLinksEditor.vue";
	import PostEditorPanel from "../components/PostEditorPanel.vue";
	import PreviewPanel from "../components/PreviewPanel.vue";
	import TaxonomyDialog from "../components/TaxonomyDialog.vue";

	const router = useRouter();
	const route = useRoute();
	const posts = ref<PostMeta[]>([]);
	const loading = ref(false);
	const keyword = ref("");
	const filterCategory = ref<string>("");
	const filterTags = ref<string[]>([]);
	const taxonomyVisible = ref(false);

	/* ---------- 左列：导航菜单（常驻，改动自动落仓） ---------- */

	const navLinks = ref<NavBarLink[]>([]);
	const navLoaded = ref(false);
	/** 程序化重载导航期间挂起自动保存，避免回写造成保存/重载循环 */
	const navSyncing = ref(false);
	const treeEditor = ref<InstanceType<typeof NavBarLinksEditor>>();
	const presetVisible = ref(false);
	let navSaveTimer: ReturnType<typeof setTimeout> | null = null;

	async function loadNav(): Promise<void> {
		try {
			const nav = await settingsApi.getNavbar();
			navSyncing.value = true;
			navLinks.value = nav.links ?? [];
			await nextTick();
			navLoaded.value = true;
		} catch (e) {
			ElMessage.error(`导航菜单加载失败：${(e as Error).message}`);
		} finally {
			navSyncing.value = false;
		}
	}

	watch(
		navLinks,
		() => {
			if (!navLoaded.value || navSyncing.value) return;
			if (navSaveTimer) clearTimeout(navSaveTimer);
			navSaveTimer = setTimeout(() => void saveNav(), 600);
		},
		{ deep: true },
	);

	/** 树中存在未命名条目（新增弹窗未落定）时视为中间态，跳过自动保存避开必填校验 */
	function navSaveReady(list: NavBarLink[]): boolean {
		return list.every(
			(l) =>
				(l.name === undefined || l.name.trim() !== "") &&
				(!l.children || navSaveReady(l.children)),
		);
	}

	async function saveNav(): Promise<void> {
		if (!navSaveReady(navLinks.value)) return;
		try {
			await settingsApi.saveNavbar({ links: navLinks.value });
		} catch (e) {
			ElMessage.error(`导航菜单保存失败：${(e as Error).message}`);
		}
	}

	/** 来源拖拽（原生 HTML5）：dataTransfer 携带双 MIME —— 导航 MIME 供树内插入链接，
	 *  文章 MIME 供分类节点接收改分类（同一拖拽按落点类型分派不同接口） */
	function postDragStart(p: PostMeta, e: DragEvent): void {
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = "copy";
		e.dataTransfer.setData(
			NAV_DROP_MIME,
			JSON.stringify({ name: p.title, url: p.permalink || `/posts/${p.slug}/` }),
		);
		e.dataTransfer.setData(POST_DROP_MIME, JSON.stringify({ path: p.path }));
	}

	/** 预设卡拖起即收起弹层，避免遮住导航树 */
	function presetDragStart(preset: string, e: DragEvent): void {
		presetVisible.value = false;
		if (!e.dataTransfer) return;
		e.dataTransfer.effectAllowed = "copy";
		e.dataTransfer.setData(NAV_DROP_MIME, JSON.stringify({ preset }));
	}

	/* ---------- 左树 ↔ 右列联动：分类过滤 / 文章定位 ---------- */

	const categoryOptions = computed(() => {
		const set = new Map<string, number>();
		let uncat = 0;
		for (const p of posts.value) {
			if (p.category) set.set(p.category, (set.get(p.category) ?? 0) + 1);
			else uncat += 1;
		}
		const out = [...set.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([name, count]) => ({ value: name, label: name, count }));
		if (uncat > 0) out.push({ value: UNCATEGORIZED, label: "未分类", count: uncat });
		return out;
	});

	/** 文章定位表：导航行 url → 文章（permalink 优先，退回默认 /posts/<slug>/，与拖拽生成一致） */
	const postByUrl = computed(() => {
		const map = new Map<string, PostMeta>();
		for (const p of posts.value) {
			if (p.permalink) map.set(p.permalink, p);
			map.set(`/posts/${p.slug}/`, p);
		}
		return map;
	});

	/** 选中文章的候选 url（命中该文的导航行高亮） */
	const activeUrls = computed(() => {
		const p = selected.value;
		if (!p) return [];
		return p.permalink ? [p.permalink, `/posts/${p.slug}/`] : [`/posts/${p.slug}/`];
	});

	/** 点击导航分类虚拟节点：切换该分类过滤（已选中时再点不处理，保持选中） */
	function onNavCategory(value: string): void {
		if (filterCategory.value === value) return;
		filterCategory.value = value;
	}

	/** 点击导航行：url 命中文章则定位选中该篇；Categories 预设节点清空分类过滤 */
	function onNavNodeClick(item: NavBarLink): void {
		if (item.url) {
			const hit = postByUrl.value.get(item.url);
			if (hit) {
				void select(hit);
				return;
			}
		}
		if (item.preset === "Categories") filterCategory.value = "";
	}

	/** 分类节点行内改名：taxonomy 接口改写该分类全部文章，随后刷新列表与计数 */
	async function onCatRename(from: string, to: string): Promise<void> {
		try {
			const r = await taxonomyApi.rename({ kind: "category", from, to });
			ElMessage.success(`已改写 ${r.changed} 篇文章`);
			if (filterCategory.value === from) filterCategory.value = to;
			await load();
		} catch (e) {
			ElMessage.error(`重命名失败：${(e as Error).message}`);
		}
	}

	/** 文章拖入分类节点：取最新正文后仅改 category 落盘（未分类哨兵 = 清空），
	 *  就地同步列表与右栏，不整页刷新 */
	async function onCatAssign(categoryValue: string, postPath: string): Promise<void> {
		const target = categoryValue === UNCATEGORIZED ? "" : categoryValue;
		const p = posts.value.find((x) => x.path === postPath);
		if (!p || (p.category ?? "") === target) return;
		try {
			const d = await postApi.detail(postPath);
			const r = await postApi.save({ path: postPath, meta: { category: target }, body: d.body });
			const idx = posts.value.findIndex((x) => x.path === postPath);
			if (idx >= 0) posts.value[idx] = r.meta;
			if (selected.value?.path === postPath) {
				selected.value = r.meta;
				// 就地编辑态不动 detail，避免覆盖编辑器中未保存的稿
				if (mode.value !== "edit") detail.value = r;
			}
			ElMessage.success(target ? `已移入「${target}」` : "已移出分类");
		} catch (e) {
			ElMessage.error(`移入分类失败：${(e as Error).message}`);
		}
	}

	/* ---------- 右侧预览 / 就地编辑 ---------- */

	const selected = ref<PostMeta | null>(null);
	const detail = ref<PostFile | null>(null);
	const detailLoading = ref(false);
	/** 预览正文：./images/ 相对引用重写为 /content-posts 直链 */
	const previewBody = computed(() =>
		detail.value ? postPreviewBody(detail.value.body, detail.value.meta.path) : "",
	);

	/** md 预览的本地媒体地址（/ 与 assets/ 前缀）重写为代理直链 */
	function mediaSanitize(html: string): string {
		return localMediaSanitize(html);
	}
	/** 右栏模式：preview 渲染正文 / edit 原地切换编辑器 / site 嵌真站预览（点左侧任一文章退回 preview） */
	const mode = ref<"preview" | "edit" | "site">("preview");
	const inlineEditor = ref<InstanceType<typeof PostEditorPanel>>();

	async function select(p: PostMeta): Promise<void> {
		// 站点预览态下点同一篇也放行，借此回到文章预览
		if (selected.value?.path === p.path && mode.value !== "site") return;
		// 就地编辑有改动时先静默自动保存（保存失败则留在当前文章，不丢稿）
		if (mode.value === "edit" && inlineEditor.value) {
			if (!(await inlineEditor.value.autoSaveIfDirty())) return;
		}
		mode.value = "preview";
		selected.value = p;
		detail.value = null;
		detailLoading.value = true;
		try {
			detail.value = await postApi.detail(p.path);
		} catch (e) {
			ElMessage.error((e as Error).message);
			selected.value = null;
		} finally {
			detailLoading.value = false;
		}
	}

	/** 点击「编辑」：右栏原地切换为完整编辑器（右上角分栏图标可进入完整编辑页） */
	function startInlineEdit(): void {
		mode.value = "edit";
	}

	/** 点击「站点预览」：右栏整面切真站预览（未就绪时面板自动点火启动 dev server） */
	async function openSitePreview(): Promise<void> {
		if (mode.value === "edit" && inlineEditor.value) {
			if (!(await inlineEditor.value.autoSaveIfDirty())) return;
		}
		mode.value = "site";
	}

	/** 就地保存成功：同步左列表与详情基线（编辑器留在编辑态，与完整编辑页一致） */
	function onInlineSaved(result: PostFile): void {
		detail.value = result;
		const idx = posts.value.findIndex((p) => p.path === result.meta.path);
		if (idx >= 0) posts.value[idx] = result.meta;
		if (selected.value) selected.value = result.meta;
		// server 端可能同步了导航里的文章快照链接，拉回最新
		void loadNav();
	}

	const publishToggling = ref(false);

	/** 发布 / 撤回发布：切换 draft 标志，正文按当前详情原样回写 */
	async function togglePublish(p: PostMeta): Promise<void> {
		if (!detail.value || detail.value.meta.path !== p.path || publishToggling.value) return;
		publishToggling.value = true;
		try {
			const result = await postApi.save({
				path: p.path,
				meta: { draft: !p.draft },
				body: detail.value.body,
			});
			onInlineSaved(result);
			ElMessage.success(result.meta.draft ? "已撤回发布（转为草稿）" : "已发布");
		} catch (e) {
			ElMessage.error(`操作失败：${(e as Error).message}`);
		} finally {
			publishToggling.value = false;
		}
	}

	const pinToggling = ref<string | null>(null);

	/** 置顶 / 取消置顶：列表卡片悬浮操作；先取正文再原样回写，防误清空 */
	async function togglePin(p: PostMeta): Promise<void> {
		if (pinToggling.value) return;
		pinToggling.value = p.path;
		try {
			const file =
				detail.value?.meta.path === p.path ? detail.value : await postApi.detail(p.path);
			const result = await postApi.save({
				path: p.path,
				meta: { pinned: !p.pinned },
				body: file.body,
			});
			const idx = posts.value.findIndex((x) => x.path === result.meta.path);
			if (idx >= 0) posts.value[idx] = result.meta;
			if (detail.value?.meta.path === result.meta.path) detail.value = result;
			if (selected.value?.path === result.meta.path) selected.value = result.meta;
			ElMessage.success(result.meta.pinned ? "已置顶" : "已取消置顶");
		} catch (e) {
			ElMessage.error(`操作失败：${(e as Error).message}`);
		} finally {
			pinToggling.value = null;
		}
	}

	/** 编辑器内删除：回到预览并重载列表 */
	async function onInlineRemoved(): Promise<void> {
		mode.value = "preview";
		await load();
		void loadNav();
	}

	const tags = computed(() => {
		const set = new Map<string, number>();
		for (const p of posts.value) {
			for (const t of p.tags) set.set(t, (set.get(t) ?? 0) + 1);
		}
		return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
	});

	const filtered = computed(() => {
		const kw = keyword.value.trim().toLowerCase();
		const cat = filterCategory.value;
		return posts.value.filter((p) => {
			if (cat && (p.category || UNCATEGORIZED) !== cat) return false;
			if (filterTags.value.length && !filterTags.value.every((t) => p.tags.includes(t))) return false;
			if (!kw) return true;
			return p.title.toLowerCase().includes(kw);
		});
	});

	/** 列表行时间：publishedAt 精确到秒，缺省退回文件修改时间，最后退回 published 日期 */
	function itemTime(p: PostMeta): string {
		if (p.publishedAt) return p.publishedAt.replace("T", " ").replace(/\+\d{2}:\d{2}$/, "");
		return p.mtime ?? p.published;
	}

	async function load(): Promise<void> {
		loading.value = true;
		try {
			posts.value = await postApi.list();
			// 首次进入默认选中第一篇；选中项被删后回落到第一篇
			if (!selected.value || !posts.value.some((p) => p.path === selected.value?.path)) {
				if (posts.value.length > 0) await select(posts.value[0]);
				else {
					selected.value = null;
					detail.value = null;
				}
			}
			// 从完整编辑页「返回」进来（?edit=路径）：恢复该篇的单栏编辑态，随后清掉标记
			const wantEdit = typeof route.query.edit === "string" ? route.query.edit : "";
			if (wantEdit) {
				const target = posts.value.find((p) => p.path === wantEdit);
				if (target && target.path !== selected.value?.path) await select(target);
				if (target) mode.value = "edit";
				router.replace({ query: {} });
			}
		} finally {
			loading.value = false;
		}
	}

	/** 新建：不问标题，直接建「未命名」草稿，列表底部追加一条并就地进入空白编辑 */
	async function openCreate(): Promise<void> {
		try {
			const created = await postApi.create({ title: "未命名" });
			posts.value.push(created.meta);
			await select(created.meta);
			mode.value = "edit";
		} catch (e) {
			ElMessage.error(`新建失败：${(e as Error).message}`);
		}
	}

	async function remove(p: PostMeta): Promise<void> {
		try {
			await ElMessageBox.confirm(
				p.layout === "directory"
					? `将删除「${p.title}」及其目录下全部配图。已提交过 git 的内容可从历史恢复，确定删除？`
					: `确定删除「${p.title}」？`,
				"删除文章",
				{ type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
			);
		} catch {
			return; // 用户取消
		}
		await postApi.remove(p.path);
		ElMessage.success("已删除");
		await load();
		void loadNav();
	}

	onMounted(() => {
		void load();
		void loadNav();
	});
</script>

<template>
	<div class="post-list-page">
		<TaxonomyDialog v-model="taxonomyVisible" @renamed="load" />

		<div class="content">
			<el-row class="content-row" :gutter="14">
				<!-- 最左：导航菜单（预设卡片与文章条目拖入） -->
				<el-col :span="5" class="nav-col">
					<el-card shadow="never" class="nav-panel">
						<template #header>
							<div class="nav-panel-head">
								<span>导航菜单</span>
								<div class="grow"></div>
								<el-popover v-model:visible="presetVisible" :width="380" trigger="click">
									<template #reference>
										<el-button size="small" plain>
											<el-icon><Grid /></el-icon>预设
										</el-button>
									</template>
									<el-row :gutter="8" class="preset-grid">
										<el-col v-for="p in NAV_PRESETS" :key="p.value" :span="8">
											<div
												class="preset-card"
												draggable="true"
												@dragstart="presetDragStart(p.value, $event)"
											>
												<DataIcon :icon="p.icon" :label="navPresetShort(p.label)" :size="22" />
												<span class="preset-card__name">{{ navPresetShort(p.label) }}</span>
											</div>
										</el-col>
									</el-row>
								</el-popover>
								<el-button size="small" plain @click="treeEditor?.addAndEditGroup()">
									<el-icon><Plus /></el-icon>分组
								</el-button>
								<el-button size="small" plain @click="treeEditor?.addAndEditLink()">
									<el-icon><Plus /></el-icon>链接
								</el-button>
								<el-button size="small" plain @click="taxonomyVisible = true">
									<el-icon><PriceTag /></el-icon>分类
								</el-button>
							</div>
						</template>
						<NavBarLinksEditor
							ref="treeEditor"
							:links="navLinks"
							:categories="categoryOptions"
							:active-category="filterCategory"
							:active-urls="activeUrls"
							@select-category="onNavCategory"
							@node-click="onNavNodeClick"
							@rename-category="onCatRename"
							@assign-category="onCatAssign"
						/>
					</el-card>
				</el-col>

				<!-- 左：文章列表（点击选中，右侧直接看内容；可拖入导航） -->
				<el-col :span="6" class="list-col">
					<el-card shadow="never" class="list-panel" v-loading="loading">
						<template #header>
							<div class="list-head">
								<div class="list-head-row">
									<span class="list-head-title">文章（{{ filtered.length }}/{{ posts.length }}）</span>
									<div class="grow"></div>
									<el-button type="primary" @click="openCreate">
										<el-icon><Plus /></el-icon>新建文章
									</el-button>
									<el-button plain @click="openSitePreview">
										<el-icon><View /></el-icon>站点预览
									</el-button>
									<el-button plain title="刷新" @click="load">
										<el-icon><Refresh /></el-icon>
									</el-button>
								</div>
								<div class="list-head-row">
									<el-input
										v-model="keyword"
										placeholder="标题关键字"
										clearable
										:prefix-icon="'Search'"
										class="grow"
									/>
									<el-select v-model="filterCategory" placeholder="全部分类" clearable class="grow">
										<el-option
											v-for="c in categoryOptions"
											:key="c.value"
											:value="c.value"
											:label="`${c.label}（${c.count}）`"
										/>
									</el-select>
								</div>
								<el-select v-model="filterTags" placeholder="全部标签" clearable multiple>
									<el-option
										v-for="t in tags"
										:key="t.name"
										:value="t.name"
										:label="`${t.name}（${t.count}）`"
									/>
								</el-select>
							</div>
						</template>
						<div class="list-scroll">
							<div v-if="filtered.length === 0" class="list-empty">没有符合条件的文章</div>
							<div
								v-for="p in filtered"
								:key="p.path"
								class="post-item"
								:class="{ active: p.path === selected?.path }"
								draggable="true"
								@click="select(p)"
								@dragstart="postDragStart(p, $event)"
							>
								<div class="post-item-title-row">
									<div class="post-item-title">{{ p.title }}</div>
									<div class="post-item-flags">
										<el-tag v-if="p.draft" size="small" type="warning">草稿</el-tag>
										<span
											v-else
											class="pin-toggle"
											:class="{ 'is-pinned': p.pinned, busy: pinToggling === p.path }"
											@click.stop="togglePin(p)"
										>
											<span class="pin-toggle__label pin-toggle__label--idle">
												{{ p.pinned ? "置顶" : "已发布" }}
											</span>
											<span class="pin-toggle__label pin-toggle__label--hover">
												{{ p.pinned ? "取消置顶" : "置顶" }}
											</span>
										</span>
										<el-tag v-if="p.encrypted" size="small" type="danger">加密</el-tag>
									</div>
								</div>
								<div class="post-item-meta">
									<el-tag
										v-if="p.category"
										size="small"
										class="post-item-category"
										:style="categoryCardStyle(p.category)"
									>
										{{ p.category }}
									</el-tag>
									<span class="muted post-item-time">
										{{ itemTime(p) }}
									</span>
								</div>
								<div v-if="p.tags.length" class="post-item-tags">
									<el-tag v-for="t in p.tags" :key="t" size="small" :style="tagColorStyle(t)">
										{{ t }}
									</el-tag>
								</div>
							</div>
						</div>
					</el-card>
				</el-col>

				<!-- 右：选中文章内容预览 / 原地编辑 / 真站预览 -->
				<el-col :span="13" class="preview-col">
					<el-card
						shadow="never"
						class="preview-panel"
						:class="{ 'is-site': mode === 'site' }"
						v-loading="detailLoading"
					>
						<div v-if="mode === 'site'" class="site-preview">
							<PreviewPanel autostart frame-height="100%" title="站点预览" />
						</div>
						<PostEditorPanel
							v-else-if="selected && mode === 'edit'"
							ref="inlineEditor"
							class="inline-editor"
							:path="selected.path"
							:split="false"
							expandable
							back-text="返回预览"
							@back="mode = 'preview'"
							@saved="onInlineSaved"
							@removed="onInlineRemoved"
						/>
						<template v-else-if="selected && detail">
							<div class="preview-head">
								<div class="preview-title-row">
									<h2 class="preview-title">
										<el-tag v-if="detail.meta.draft" type="warning" class="draft-flag">草稿</el-tag>
										<el-tag v-else type="success" class="draft-flag">已发布</el-tag>
										<span class="preview-title-text">{{ detail.meta.title }}</span>
									</h2>
									<div class="preview-ops">
										<el-button type="primary" plain @click="startInlineEdit">
											<el-icon><Edit /></el-icon>编辑
										</el-button>
										<el-button
											plain
											:loading="pinToggling === selected.path"
											@click="togglePin(selected)"
										>
											<el-icon><Top /></el-icon>{{ selected.pinned ? "取消置顶" : "置顶" }}
										</el-button>
										<el-button
											v-if="detail.meta.draft"
											type="success"
											:loading="publishToggling"
											@click="togglePublish(detail.meta)"
										>
											<el-icon><Promotion /></el-icon>发布
										</el-button>
										<el-button
											v-else
											type="warning"
											:loading="publishToggling"
											@click="togglePublish(detail.meta)"
										>
											<el-icon><RefreshLeft /></el-icon>撤回发布
										</el-button>
										<el-button type="danger" plain @click="remove(selected)">删除</el-button>
									</div>
								</div>
								<div class="preview-meta">
									<span class="muted">{{ itemTime(detail.meta) }}</span>
									<el-tag v-if="detail.meta.category" size="small" type="info">
										{{ detail.meta.category }}
									</el-tag>
									<el-tag v-if="detail.meta.pinned" size="small">置顶</el-tag>
									<el-tag v-if="detail.meta.encrypted" size="small" type="danger">加密</el-tag>
								</div>
								<div v-if="detail.meta.tags.length" class="preview-tags">
									<el-tag v-for="t in detail.meta.tags" :key="t" size="small" :style="tagColorStyle(t)">
										{{ t }}
									</el-tag>
								</div>
							</div>
							<div class="preview-scroll">
								<MdPreview editor-id="post-preview" :model-value="previewBody" :sanitize="mediaSanitize" />
							</div>
						</template>
						<el-empty v-else-if="!detailLoading" description="选择左侧文章查看内容" class="preview-empty" />
					</el-card>
				</el-col>
			</el-row>
		</div>
	</div>
</template>

<style scoped>
	.post-list-page {
		height: 100%;
		display: flex;
		flex-direction: column;
		/* 本页整体字号比全局小 2px：基础面 18px，子组件经 --font-shift 跟随缩放 */
		font-size: 18px;
		--el-font-size-base: 18px;
		--font-shift: -2px;
	}
	/* styles.css 里硬编码 20px 的承载面，在本页内定点回落到 18px */
	.post-list-page :deep(.el-input__inner),
	.post-list-page :deep(.el-textarea__inner),
	.post-list-page :deep(.el-select__wrapper),
	.post-list-page :deep(.el-collapse-item__header),
	.post-list-page :deep(.el-dialog__body),
	.post-list-page :deep(.el-descriptions__body .el-descriptions__table .el-descriptions__cell) {
		font-size: 18px;
	}
	.content {
		flex: 1;
		min-height: 0;
	}
	.content-row {
		height: 100%;
	}
	.nav-col,
	.list-col,
	.preview-col {
		height: 100%;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	/* 最左列：导航菜单 */
	.nav-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.nav-panel :deep(.el-card__header) {
		padding: 8px 14px;
	}
	.nav-panel :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		padding: 6px;
		overflow-y: auto;
	}
	.nav-panel-head {
		display: flex;
		align-items: center;
		gap: 8px;
		font-weight: 600;
	}
	/* 预设弹层内卡片网格（一行三个，橙色，与树中预设条目同色） */
	.preset-grid {
		row-gap: 8px;
	}
	.preset-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		padding: 10px 4px;
		border: 1px solid var(--hairline);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.55);
		cursor: grab;
		user-select: none;
		text-align: center;
	}
	.preset-card:hover {
		border-color: rgba(230, 162, 60, 0.45);
		background: rgba(255, 255, 255, 0.72);
	}
	.preset-card:active {
		cursor: grabbing;
	}
	.preset-card__name {
		font-size: 18px;
		font-weight: 600;
		max-width: 100%;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: var(--el-color-warning);
	}
	.preset-card :deep(.data-icon) {
		color: var(--el-color-warning);
	}
	/* 左列：文章菜单列表（标题栏内嵌筛选与刷新） */
	.list-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.list-panel :deep(.el-card__header) {
		padding: 8px 10px;
	}
	.list-head {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.list-head-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.list-head-title {
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		min-width: 0;
	}
	.list-head-row .el-input,
	.list-head-row .el-select {
		min-width: 0;
	}
	.list-panel :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		padding: 6px;
	}
	.list-scroll {
		height: 100%;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 2px;
	}
	.list-empty {
		text-align: center;
		color: var(--el-text-color-secondary);
		font-size: 18px;
		padding: 30px 0;
	}
	/* 卡片格子：描边圆角小卡，悬停浮起，选中主色描边 */
	.post-item {
		flex: none;
		padding: 10px 12px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 10px;
		background: var(--el-bg-color);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			box-shadow 0.15s ease,
			background-color 0.15s ease;
	}
	.post-item:hover {
		border-color: var(--el-border-color);
		box-shadow: 0 3px 10px rgba(0, 0, 0, 0.08);
	}
	.post-item.active {
		border-color: var(--el-color-primary);
		background: rgba(99, 102, 241, 0.08);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
	}
	.post-item-title-row {
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.post-item-title {
		flex: 1;
		min-width: 0;
		font-size: 18px;
		font-weight: 500;
		line-height: 1.5;
		color: var(--el-text-color-primary);
		overflow-wrap: anywhere;
	}
	.post-item-flags {
		flex: none;
		display: flex;
		gap: 4px;
		line-height: 1;
		padding-top: 3px;
	}
	/* 状态胶囊：已发布 ⇄ 置顶，悬浮互换为操作按钮（两标签叠放同格，宽度不跳动） */
	.pin-toggle {
		flex: none;
		display: inline-grid;
		height: 24px;
		padding: 0 9px;
		border-radius: 999px;
		border: 1px solid var(--el-color-success-light-8);
		background: var(--el-color-success-light-9);
		color: #15803d;
		font-size: 12px;
		line-height: 1;
		cursor: pointer;
		user-select: none;
		transition:
			background-color 0.15s ease,
			color 0.15s ease,
			border-color 0.15s ease;
	}
	.pin-toggle.is-pinned {
		border-color: var(--el-color-primary-light-8);
		background: var(--el-color-primary-light-9);
		color: var(--el-color-primary);
	}
	.pin-toggle__label {
		grid-area: 1 / 1;
		align-self: center;
		justify-self: center;
		white-space: nowrap;
		transition: opacity 0.15s ease;
	}
	.pin-toggle__label--hover {
		opacity: 0;
	}
	.pin-toggle:hover {
		border-color: var(--el-color-primary);
		background: var(--el-color-primary);
		color: #fff;
	}
	.pin-toggle:hover .pin-toggle__label--idle {
		opacity: 0;
	}
	.pin-toggle:hover .pin-toggle__label--hover {
		opacity: 1;
	}
	.pin-toggle.busy {
		pointer-events: none;
		opacity: 0.6;
	}
	.post-item-meta {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
	}
	.post-item-time {
		margin-left: auto;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}
	/* 分类：方形彩色卡片（覆盖全局胶囊 999px），与下方圆角标签错开 */
	.post-item-category {
		flex: none;
		max-width: 60%;
		border-radius: 4px;
		font-weight: 600;
	}
	.post-item-category :deep(.el-tag__content) {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.post-item-tags {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 6px;
	}
	/* 右列：内容预览 / 就地编辑（与完整编辑页共用 PostEditorPanel） */
	.preview-panel {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-panel :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		padding: 8px 12px 12px;
	}
	.preview-head {
		flex: none;
		border-bottom: 1px solid var(--el-border-color-lighter);
		padding-bottom: 10px;
		margin-bottom: 6px;
	}
	.preview-title-row {
		display: flex;
		align-items: flex-start;
		gap: 12px;
	}
	.preview-title {
		flex: 1;
		min-width: 0;
		margin: 0 0 6px;
		display: flex;
		align-items: flex-start;
		gap: 8px;
	}
	.preview-title-text {
		min-width: 0;
		font-size: 18px;
		line-height: 1.4;
		word-break: break-all;
	}
	.preview-title :deep(.draft-flag) {
		flex: none;
		font-size: 16px;
		height: 26px;
		padding: 0 12px;
	}
	.preview-ops {
		flex: none;
		display: flex;
		gap: 8px;
	}
	.preview-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.preview-tags {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
		margin-top: 6px;
	}
	.preview-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.preview-scroll :deep(.md-editor) {
		--md-bk-color: #fff;
		border-radius: 12px;
		/* 空正文也撑满：白色纸张面不塌缩成一条 */
		min-height: 100%;
		box-sizing: border-box;
	}
	/* 正文 ≥ 20px：就地预览的 Markdown 正文同步抬高；去默认顶距，正文顶到顶部 */
	.preview-scroll :deep(.md-editor-preview) {
		font-size: 18px;
	}
	.preview-scroll :deep(.md-editor-preview-wrapper) {
		padding-top: 0;
	}
	/* 就地编辑：共用组件占满卡片剩余高度 */
	.inline-editor {
		flex: 1;
		min-height: 0;
	}
	/* 站点预览态：卡片体让位给整面真站 iframe（铺法同设置页） */
	.site-preview {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-panel.is-site :deep(.el-card__body) {
		padding: 0;
	}
	.preview-panel.is-site :deep(.panel) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-panel.is-site :deep(.frame-wrap) {
		flex: 1;
		min-height: 0;
		border: none;
		border-radius: 0;
	}
	.preview-empty {
		margin: auto;
	}
	.muted {
		color: var(--el-text-color-secondary);
		font-size: 18px;
	}
	/* 状态标签文字加深：EP 默认 success/warning 文字色在浅底上对比不足 */
	.post-list-page :deep(.el-tag--success) {
		--el-tag-text-color: #15803d;
	}
	.post-list-page :deep(.el-tag--warning) {
		--el-tag-text-color: #b45309;
	}
</style>
