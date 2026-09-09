<script setup lang="ts">
	import { computed, onMounted, ref } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { MdPreview } from "md-editor-v3";
	import type { PostFile, PostMeta } from "@shirone-admin/shared";
	import { postApi } from "../api";
	import { localMediaSanitize, postPreviewBody } from "../utils/content-media";
	import PostEditorPanel from "../components/PostEditorPanel.vue";
	import TaxonomyDialog from "../components/TaxonomyDialog.vue";

	const router = useRouter();
	const route = useRoute();
	const posts = ref<PostMeta[]>([]);
	const loading = ref(false);
	const keyword = ref("");
	const filterCategory = ref<string>("");
	const filterTag = ref<string>("");
	const taxonomyVisible = ref(false);

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
	/** 右栏模式：preview 渲染正文 / edit 原地切换编辑器（与完整编辑页共用 PostEditorPanel，无分栏预览） */
	const mode = ref<"preview" | "edit">("preview");
	const inlineEditor = ref<InstanceType<typeof PostEditorPanel>>();

	async function select(p: PostMeta): Promise<void> {
		if (selected.value?.path === p.path) return;
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

	/** 就地保存成功：同步左列表与详情基线（编辑器留在编辑态，与完整编辑页一致） */
	function onInlineSaved(result: PostFile): void {
		detail.value = result;
		const idx = posts.value.findIndex((p) => p.path === result.meta.path);
		if (idx >= 0) posts.value[idx] = result.meta;
		if (selected.value) selected.value = result.meta;
	}

	/** 编辑器内删除：回到预览并重载列表 */
	async function onInlineRemoved(): Promise<void> {
		mode.value = "preview";
		await load();
	}

	const categories = computed(() => {
		const set = new Map<string, number>();
		for (const p of posts.value) {
			if (p.category) set.set(p.category, (set.get(p.category) ?? 0) + 1);
		}
		return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
	});

	const tags = computed(() => {
		const set = new Map<string, number>();
		for (const p of posts.value) {
			for (const t of p.tags) set.set(t, (set.get(t) ?? 0) + 1);
		}
		return [...set.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
	});

	const filtered = computed(() => {
		const kw = keyword.value.trim().toLowerCase();
		return posts.value.filter((p) => {
			if (filterCategory.value && p.category !== filterCategory.value) return false;
			if (filterTag.value && !p.tags.includes(filterTag.value)) return false;
			if (!kw) return true;
			return (
				p.title.toLowerCase().includes(kw) ||
				p.category.toLowerCase().includes(kw) ||
				p.tags.some((t) => t.toLowerCase().includes(kw))
			);
		});
	});

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

	async function openCreate(): Promise<void> {
		const { value } = await ElMessageBox.prompt("标题（保存页可随时修改）", "新建文章", {
			confirmButtonText: "创建",
			cancelButtonText: "取消",
			inputPlaceholder: "文章标题",
			inputValidator: (v: string) => (v.trim() ? true : "标题不能为空"),
		}).catch(() => ({ value: null as string | null }));
		if (!value) return;
		const created = await postApi.create({ title: value });
		ElMessage.success("已创建（草稿状态）");
		router.push({ path: "/posts/edit", query: { path: created.meta.path } });
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
	}

	onMounted(load);
</script>

<template>
	<div class="post-list-page">
		<div class="page-toolbar">
			<el-button type="primary" @click="openCreate">
				<el-icon><Plus /></el-icon>新建文章
			</el-button>
			<el-input
				v-model="keyword"
				placeholder="搜索标题 / 分类 / 标签"
				clearable
				style="width: 200px"
				:prefix-icon="'Search'"
			/>
			<el-select v-model="filterCategory" placeholder="全部分类" clearable style="width: 130px">
				<el-option v-for="c in categories" :key="c.name" :value="c.name" :label="`${c.name}（${c.count}）`" />
			</el-select>
			<el-select v-model="filterTag" placeholder="全部标签" clearable style="width: 130px">
				<el-option v-for="t in tags" :key="t.name" :value="t.name" :label="`${t.name}（${t.count}）`" />
			</el-select>
			<div class="grow"></div>
			<el-button @click="taxonomyVisible = true">
				<el-icon><PriceTag /></el-icon>分类管理
			</el-button>
			<el-button @click="load">刷新</el-button>
		</div>

		<TaxonomyDialog v-model="taxonomyVisible" @renamed="load" />

		<div class="content">
			<!-- 左：文章列表（点击选中，右侧直接看内容） -->
			<el-card shadow="never" class="list-panel" v-loading="loading">
				<template #header>
					文章（{{ filtered.length }}/{{ posts.length }}）
				</template>
				<div class="list-scroll">
					<div v-if="filtered.length === 0" class="list-empty">没有符合条件的文章</div>
					<div
						v-for="p in filtered"
						:key="p.path"
						class="post-item"
						:class="{ active: p.path === selected?.path }"
						@click="select(p)"
					>
						<div class="post-item-title">{{ p.title }}</div>
						<div class="post-item-meta">
							<span class="muted">{{ p.published }}</span>
							<span v-if="p.category" class="muted">{{ p.category }}</span>
							<el-tag v-if="p.draft" size="small" type="warning">草稿</el-tag>
							<el-tag v-if="p.pinned" size="small">置顶</el-tag>
							<el-tag v-if="p.encrypted" size="small" type="danger">加密</el-tag>
						</div>
					</div>
				</div>
			</el-card>

			<!-- 右：选中文章内容预览 / 原地编辑 -->
			<el-card shadow="never" class="preview-panel" v-loading="detailLoading">
				<PostEditorPanel
					v-if="selected && mode === 'edit'"
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
							<h2 class="preview-title">{{ detail.meta.title }}</h2>
							<div class="preview-ops">
								<el-button type="primary" plain @click="startInlineEdit">
									<el-icon><Edit /></el-icon>编辑
								</el-button>
								<el-button type="danger" plain @click="remove(selected)">删除</el-button>
							</div>
						</div>
						<div class="preview-meta">
							<span class="muted">{{ detail.meta.published }}</span>
							<el-tag v-if="detail.meta.category" size="small" type="info">
								{{ detail.meta.category }}
							</el-tag>
							<el-tag v-for="t in detail.meta.tags" :key="t" size="small" type="info">{{ t }}</el-tag>
							<el-tag v-if="detail.meta.draft" size="small" type="warning">草稿</el-tag>
							<el-tag v-if="detail.meta.pinned" size="small">置顶</el-tag>
							<el-tag v-if="detail.meta.encrypted" size="small" type="danger">加密</el-tag>
						</div>
					</div>
					<div class="preview-scroll">
						<MdPreview editor-id="post-preview" :model-value="previewBody" :sanitize="mediaSanitize" />
					</div>
				</template>
				<el-empty v-else-if="!detailLoading" description="选择左侧文章查看内容" class="preview-empty" />
			</el-card>
		</div>
	</div>
</template>

<style scoped>
	.post-list-page {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.page-toolbar {
		flex: none;
	}
	.content {
		flex: 1;
		min-height: 0;
		display: flex;
		gap: 14px;
		align-items: stretch;
	}
	/* 左列：文章菜单列表 */
	.list-panel {
		flex: 0 0 340px;
		display: flex;
		flex-direction: column;
		min-width: 300px;
	}
	.list-panel :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		padding: 6px;
	}
	.list-scroll {
		height: 100%;
		overflow: auto;
	}
	.list-empty {
		text-align: center;
		color: var(--el-text-color-secondary);
		font-size: 20px;
		padding: 30px 0;
	}
	.post-item {
		padding: 8px 10px;
		border-radius: 8px;
		cursor: pointer;
		transition: background-color 0.15s ease;
	}
	.post-item:hover {
		background: rgba(120, 120, 160, 0.08);
	}
	.post-item.active {
		background: rgba(99, 102, 241, 0.12);
	}
	.post-item-title {
		font-size: 20px;
		font-weight: 500;
		color: var(--el-text-color-primary);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.post-item-meta {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 3px;
		flex-wrap: wrap;
	}
	/* 右列：内容预览 / 就地编辑（与完整编辑页共用 PostEditorPanel） */
	.preview-panel {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.preview-panel :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
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
		font-size: 20px;
		line-height: 1.4;
		word-break: break-all;
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
	.preview-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.preview-scroll :deep(.md-editor) {
		--md-bk-color: transparent;
	}
	/* 正文 ≥ 20px：就地预览的 Markdown 正文同步抬高 */
	.preview-scroll :deep(.md-editor-preview) {
		font-size: 20px;
	}
	/* 就地编辑：共用组件占满卡片剩余高度 */
	.inline-editor {
		flex: 1;
		min-height: 0;
	}
	.preview-empty {
		margin: auto;
	}
	.muted {
		color: var(--el-text-color-secondary);
		font-size: 20px;
	}
</style>
