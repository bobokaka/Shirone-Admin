<script setup lang="ts">
	import { computed, nextTick, onMounted, ref, watch } from "vue";
	import type { ComponentPublicInstance } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import type { UploadRequestOptions } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { MomentMeta } from "@shirone-admin/shared";
	import { aiApi, mediaApi, momentApi } from "../api";
	import { useAiConsoleStore } from "../stores/aiConsole";
	import { contentPreviewUrl } from "../utils/assets";
	import { parseLooseJson } from "../utils/looseJson";

	const list = ref<MomentMeta[]>([]);
	const loading = ref(false);
	const submitting = ref(false);
	const editingPath = ref<string | null>(null);
	const composerCard = ref<ComponentPublicInstance>();

	const text = ref("");
	const published = ref("");
	const location = ref("");
	const mood = ref("");
	const tags = ref<string[]>([]);
	const draftFlag = ref(false);
	const pinnedFlag = ref(false);
	// 预生成批次号：并发多选上传也归入同一批次目录（server 校验 /^[\w-]+$/）
	const batchId = ref(newBatchId());
	const uploaded = ref<Array<{ src: string; name: string }>>([]);

	const MOODS = [
		{ value: "material-symbols:sentiment-satisfied-outline-rounded", label: "😊 开心" },
		{ value: "material-symbols:sentiment-excited-outline-rounded", label: "🤩 兴奋" },
		{ value: "material-symbols:sentiment-neutral-outline-rounded", label: "😐 平静" },
		{ value: "material-symbols:sentiment-dissatisfied-outline-rounded", label: "😔 低落" },
		{ value: "material-symbols:sentiment-sad-outline-rounded", label: "😢 难过" },
		{ value: "material-symbols:favorite", label: "❤️ 喜欢" },
		{ value: "material-symbols:celebration", label: "🎉 庆祝" },
		{ value: "material-symbols:coffee", label: "☕ 小酌" },
		{ value: "material-symbols:bedtime", label: "🌙 晚安" },
	];

	function nowStamp(): string {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
	}

	/** 图片批次目录名，格式与 server momentId 一致：yyyymmdd-HHmmss */
	function newBatchId(): string {
		const s = nowStamp();
		return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}`;
	}

	/** 心情图标名 → emoji（MOODS label 前缀），未收录返回空串不渲染 */
	function moodEmoji(v: string): string {
		return MOODS.find((m) => m.value === v)?.label.split(" ")[0] ?? "";
	}

	async function load(): Promise<void> {
		loading.value = true;
		try {
			list.value = await momentApi.list();
		} finally {
			loading.value = false;
		}
	}

	function resetComposer(): void {
		editingPath.value = null;
		text.value = "";
		published.value = nowStamp();
		location.value = "";
		mood.value = "";
		tags.value = [];
		draftFlag.value = false;
		pinnedFlag.value = false;
		batchId.value = newBatchId();
		uploaded.value = [];
	}

	async function doUpload(options: UploadRequestOptions): Promise<void> {
		try {
			const r = await mediaApi.momentImage(batchId.value, options.file as File);
			batchId.value = r.batchId ?? batchId.value;
			uploaded.value.push({ src: r.src, name: r.fileName });
			options.onSuccess(r);
		} catch (e) {
			options.onError(e as unknown as Parameters<typeof options.onError>[0]);
			ElMessage.error((e as Error).message);
		}
	}

	function removeUploaded(src: string): void {
		uploaded.value = uploaded.value.filter((i) => i.src !== src);
		ElMessage.info("已从本次发布移除（文件仍留在仓库，可在发布前忽略或手动删除）");
	}

	async function submit(asDraft: boolean): Promise<void> {
		if (!text.value.trim() && uploaded.value.length === 0) {
			ElMessage.warning("写点内容或选张图吧");
			return;
		}
		submitting.value = true;
		try {
			const input = {
				published: published.value || nowStamp(),
				location: location.value,
				mood: mood.value,
				tags: tags.value,
				images: uploaded.value.map((i) => ({ src: i.src, alt: "" })),
				draft: asDraft || draftFlag.value,
				pinned: pinnedFlag.value,
				body: text.value,
			};
			if (editingPath.value) {
				await momentApi.update(editingPath.value, input);
				ElMessage.success("说说已更新");
			} else {
				await momentApi.create(input);
				ElMessage.success(asDraft ? "已存草稿" : "说说已发布（记得到发布页提交上线）");
			}
			resetComposer();
			await load();
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			submitting.value = false;
		}
	}

	async function edit(m: MomentMeta): Promise<void> {
		const detail = await momentApi.detail(m.path).catch((e: Error) => {
			ElMessage.error(e.message);
			return null;
		});
		if (!detail) return;
		editingPath.value = m.path;
		text.value = detail.body;
		published.value = detail.meta.published;
		location.value = detail.meta.location;
		mood.value = detail.meta.mood;
		tags.value = [...detail.meta.tags];
		draftFlag.value = detail.meta.draft;
		pinnedFlag.value = detail.meta.pinned;
		// 编辑时新上传的图进新批次，不追加旧目录
		batchId.value = newBatchId();
		uploaded.value = detail.meta.images.map((i) => ({ src: i.src, name: i.src }));
		// 编辑器是独立滚动区，回填后归顶方便从头核对
		await nextTick();
		const body = (composerCard.value?.$el as HTMLElement | undefined)?.querySelector<HTMLElement>(
			".el-card__body",
		);
		if (body) body.scrollTop = 0;
	}

	async function togglePin(m: MomentMeta): Promise<void> {
		const detail = await momentApi.detail(m.path);
		await momentApi.update(m.path, {
			published: detail.meta.published,
			location: detail.meta.location,
			mood: detail.meta.mood,
			tags: detail.meta.tags,
			images: detail.meta.images,
			draft: detail.meta.draft,
			pinned: !detail.meta.pinned,
			body: detail.body,
		});
		await load();
	}

	async function remove(m: MomentMeta): Promise<void> {
		await ElMessageBox.confirm(
			"删除这条说说？（配图文件保留在 public/images/moments/，如需清理请手动处理）",
			"删除说说",
			{ type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
		);
		await momentApi.remove(m.path);
		ElMessage.success("已删除");
		await load();
	}

	/* ---------- 筛选与分页 ---------- */

	const keyword = ref("");
	const statusFilter = ref<"all" | "published" | "draft">("all");
	const tagFilter = ref<string[]>([]);
	const pinnedOnly = ref(false);
	const page = ref(1);
	const pageSize = ref(8);

	/** 全量标签选项（当前说说出现过的标签聚合，中文排序） */
	const allTags = computed(() =>
		[...new Set(list.value.flatMap((m) => m.tags))].sort((a, b) => a.localeCompare(b, "zh")),
	);

	const filtered = computed(() =>
		list.value.filter((m) => {
			if (statusFilter.value === "draft" && !m.draft) return false;
			if (statusFilter.value === "published" && m.draft) return false;
			if (pinnedOnly.value && !m.pinned) return false;
			if (tagFilter.value.length && !tagFilter.value.every((t) => m.tags.includes(t))) return false;
			const kw = keyword.value.trim().toLowerCase();
			if (kw) {
				const hay = `${m.body} ${m.location} ${m.tags.join(" ")}`.toLowerCase();
				if (!hay.includes(kw)) return false;
			}
			return true;
		}),
	);

	const paged = computed(() =>
		filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value),
	);

	/** 点击卡片上的标签 = 筛选该标签（再点取消） */
	function toggleTag(t: string): void {
		tagFilter.value = tagFilter.value.includes(t)
			? tagFilter.value.filter((x) => x !== t)
			: [...tagFilter.value, t];
	}

	watch([keyword, statusFilter, tagFilter, pinnedOnly, pageSize], () => {
		page.value = 1;
	});
	// 删除/筛选后总页数变少时收拢当前页
	watch(
		() => filtered.value.length,
		(len) => {
			const max = Math.max(1, Math.ceil(len / pageSize.value));
			if (page.value > max) page.value = max;
		},
	);

	/* ---------- AI 辅助（润色正文 / 建议标签与心情；AI 未启用时不出现）---------- */

	const aiEnabled = ref(false);
	/** 润色走全局流式控制台（思考可见、可随时停止）；标签建议是快速 JSON 任务，仍走一次性接口 */
	const aiConsole = useAiConsoleStore();
	const polishing = computed(() => aiConsole.running);
	const suggesting = ref(false);

	async function polishText(): Promise<void> {
		if (polishing.value) return;
		if (text.value.trim() === "") {
			ElMessage.warning("先写点内容，AI 才能润色");
			return;
		}
		// 流式回填：润色结果直接在输入框里长出来；停止/失败恢复原文
		const original = text.value;
		const result = await aiConsole.run(
			"AI润色说说",
			{
				instruction: "润色这条说说：口语化自然、保留语气与事实，只输出结果",
				text: original,
				maxTokens: 4096,
			},
			{ onText: (full) => (text.value = full) },
		);
		text.value = result ?? original;
	}

	/** AI 从正文提取标签（合并去重）+ 猜测心情（按中文词映射 MOODS 图标，已有值不覆盖） */
	async function suggestMeta(): Promise<void> {
		if (suggesting.value) return;
		if (text.value.trim() === "") {
			ElMessage.warning("先写点内容，AI 才能建议标签");
			return;
		}
		suggesting.value = true;
		try {
			const moodWords = MOODS.map((m) => m.label.split(" ")[1]).join("|");
			const r = await aiApi.chat(
				[
					{
						role: "system",
						content:
							"你是说说标签助手。只输出一个 JSON 对象，不要解释或代码围栏：" +
							`{"tags":["…"],"mood":"…"}。tags 为 2-4 个简短中文标签；` +
							`mood 只能取 ${moodWords} 之一，判断不出取空字符串。`,
					},
					{ role: "user", content: text.value },
				],
				undefined,
				{ fast: true },
			);
			const parsed = parseLooseJson(r.content) as { tags?: unknown; mood?: unknown } | null;
			if (!parsed) {
				ElMessage.warning("AI 输出无法解析，请重试");
				return;
			}
			if (Array.isArray(parsed.tags)) {
				const merged = [...tags.value];
				for (const t of parsed.tags) {
					const s = typeof t === "string" ? t.trim() : "";
					if (s !== "" && !merged.includes(s)) merged.push(s);
				}
				if (merged.length > tags.value.length) {
					tags.value = merged;
					ElMessage.success("已合并 AI 标签");
				} else {
					ElMessage.info("AI 没有给出新标签");
				}
			}
			const moodWord = typeof parsed.mood === "string" ? parsed.mood.trim() : "";
			if (moodWord !== "") {
				const hit = MOODS.find((m) => m.label.split(" ")[1] === moodWord);
				if (hit) {
					if (mood.value === "") mood.value = hit.value;
					else ElMessage.info(`AI 猜测心情「${moodWord}」，已保留现有选择`);
				}
			}
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			suggesting.value = false;
		}
	}

	onMounted(() => {
		published.value = nowStamp();
		load();
		// AI 是否启用只读一次：控制润色与标签建议入口
		aiApi
			.getSettings()
			.then((s) => (aiEnabled.value = s.enable))
			.catch(() => {});
	});
</script>

<template>
	<div class="moments">
		<el-card ref="composerCard" shadow="never" class="composer" :class="{ editing: !!editingPath }">
			<template #header>
				{{ editingPath ? "编辑说说" : "发说说" }}
				<el-button v-if="editingPath" size="small" style="float: right" @click="resetComposer">
					取消编辑
				</el-button>
			</template>
			<el-input
				v-model="text"
				type="textarea"
				:rows="5"
				resize="none"
				placeholder="此刻的想法…"
			/>
			<div class="image-grid">
				<div v-for="img in uploaded" :key="img.src" class="image-item">
					<el-image
						:src="contentPreviewUrl(img.src) ?? ''"
						fit="cover"
						:preview-src-list="[contentPreviewUrl(img.src) ?? '']"
						preview-teleported
					/>
					<el-button class="image-remove" size="small" circle type="danger" @click="removeUploaded(img.src)">
						<el-icon><Close /></el-icon>
					</el-button>
				</div>
				<el-upload
					v-if="uploaded.length < 9"
					:show-file-list="false"
					:http-request="doUpload"
					accept=".webp,.png,.jpg,.jpeg,.gif,.avif"
					multiple
				>
					<div class="upload-trigger">
						<el-icon><Plus /></el-icon>
					</div>
				</el-upload>
			</div>
			<div class="composer-meta">
				<el-select v-model="mood" placeholder="心情" clearable style="width: 130px">
					<el-option v-for="m in MOODS" :key="m.value" :label="m.label" :value="m.value" />
				</el-select>
				<el-input v-model="location" placeholder="地点，如：北京 · 朝阳" style="width: 170px" />
				<div class="tags-field">
					<el-select
						v-model="tags"
						multiple
						filterable
						allow-create
						default-first-option
						placeholder="标签"
						style="width: 100%"
					>
						<el-option v-for="t in allTags" :key="t" :value="t" :label="t" />
					</el-select>
					<el-tooltip v-if="aiEnabled" content="AI 从正文提取标签并猜测心情" placement="top">
						<el-button
							size="small"
							:loading="suggesting"
							:disabled="suggesting"
							@click="suggestMeta"
						>
							<el-icon v-if="!suggesting"><Icon icon="material-symbols:auto-awesome" /></el-icon>
							AI建议
						</el-button>
					</el-tooltip>
				</div>
				<el-date-picker
					v-model="published"
					type="datetime"
					value-format="YYYY-MM-DD HH:mm:ss"
					style="width: 100%"
				/>
				<el-checkbox v-model="pinnedFlag">置顶</el-checkbox>
			</div>
			<div class="composer-actions">
				<el-tooltip
					v-if="aiEnabled"
					content="AI 润色：口语化自然、保留语气与事实（流式生成，可随时停止）"
					placement="top"
				>
					<el-button :disabled="polishing" @click="polishText">
						<el-icon><Icon icon="material-symbols:autoawesome" /></el-icon>AI润色
					</el-button>
				</el-tooltip>
				<el-button :loading="submitting" @click="submit(true)">存草稿</el-button>
				<el-button type="primary" :loading="submitting" @click="submit(false)">发布说说</el-button>
			</div>
		</el-card>

		<el-card shadow="never" class="list-col" v-loading="loading">
			<template #header>
				<div class="list-head">
					<span class="list-title">说说（{{ filtered.length }}/{{ list.length }}）</span>
					<div class="filters">
						<el-input
							v-model="keyword"
							placeholder="搜正文 / 地点 / 标签"
							clearable
							style="width: 170px"
						/>
						<el-select v-model="statusFilter" style="width: 104px">
							<el-option value="all" label="全部状态" />
							<el-option value="published" label="已发布" />
							<el-option value="draft" label="草稿" />
						</el-select>
						<el-select
							v-model="tagFilter"
							multiple
							filterable
							clearable
							collapse-tags
							collapse-tags-tooltip
							placeholder="标签"
							style="width: 180px"
						>
							<el-option v-for="t in allTags" :key="t" :value="t" :label="t" />
						</el-select>
						<el-checkbox v-model="pinnedOnly">只看置顶</el-checkbox>
					</div>
				</div>
			</template>
			<div class="list-scroll">
				<el-empty v-if="list.length === 0" description="还没有说说，左侧发第一条吧" />
				<el-empty v-else-if="paged.length === 0" description="没有符合筛选条件的说说" />
				<div v-for="m in paged" :key="m.path" class="moment-card">
					<div class="moment-head">
						<span class="moment-time">{{ m.published }}</span>
						<span v-if="moodEmoji(m.mood)" class="mood" :title="m.mood">{{ moodEmoji(m.mood) }}</span>
						<el-tag v-if="m.pinned" size="small">置顶</el-tag>
						<el-tag v-if="m.draft" size="small" type="warning">草稿</el-tag>
						<span v-if="m.location" class="muted">{{ m.location }}</span>
					</div>
					<div class="pre-wrap moment-body">{{ m.body }}</div>
					<div v-if="m.images.length" class="image-grid small">
						<el-image
							v-for="img in m.images"
							:key="img.src"
							:src="contentPreviewUrl(img.src) ?? ''"
							:preview-src-list="m.images.map((i) => contentPreviewUrl(i.src) ?? '')"
							:initial-index="m.images.indexOf(img)"
							fit="cover"
							preview-teleported
							lazy
						/>
					</div>
					<div class="moment-foot">
						<el-tag
							v-for="t in m.tags"
							:key="t"
							size="small"
							type="info"
							class="moment-tag"
							:effect="tagFilter.includes(t) ? 'dark' : 'light'"
							@click="toggleTag(t)"
						>
							{{ t }}
						</el-tag>
						<span class="grow"></span>
						<el-button size="small" type="primary" plain @click="edit(m)">编辑</el-button>
						<el-button size="small" @click="togglePin(m)">{{ m.pinned ? "取消置顶" : "置顶" }}</el-button>
						<el-button size="small" type="danger" plain @click="remove(m)">删除</el-button>
					</div>
				</div>
			</div>
			<div class="list-foot">
				<el-pagination
					v-model:current-page="page"
					v-model:page-size="pageSize"
					:total="filtered.length"
					:page-sizes="[5, 8, 10, 20]"
					layout="total, sizes, prev, pager, next"
					background
				/>
			</div>
		</el-card>
	</div>
</template>

<style scoped>
	.moments {
		height: 100%;
		display: flex;
		gap: 14px;
		align-items: stretch;
	}
	/* 左栏：写说说，占 1/3，内容超高时自身滚动 */
	.composer {
		flex: 0 0 33%;
		min-width: 320px;
		display: flex;
		flex-direction: column;
	}
	.composer.editing {
		outline: 2px solid var(--el-color-primary-light-5);
	}
	.composer :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.composer-meta {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		margin-top: 12px;
	}
	/* 标签选择 + AI 建议按钮同排占满剩余宽度 */
	.tags-field {
		flex: 1;
		min-width: 220px;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.composer-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 12px;
	}
	/* 右栏：筛选 + 滚动列表 + 底部分页 */
	.list-col {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.list-col :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.list-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		flex-wrap: wrap;
	}
	.list-title {
		font-weight: 600;
		white-space: nowrap;
	}
	.filters {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.list-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.list-foot {
		flex: none;
		display: flex;
		justify-content: flex-end;
		padding-top: 10px;
	}
	.moment-card {
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		padding: 10px 12px;
		margin-bottom: 10px;
	}
	.moment-head {
		display: flex;
		gap: 8px;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 6px;
	}
	.moment-time {
		font-size: 20px;
		font-weight: 600;
		color: var(--el-text-color-primary);
	}
	.mood {
		font-size: 20px;
		line-height: 1;
	}
	.moment-body {
		margin-bottom: 6px;
	}
	.moment-foot {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
		margin-top: 4px;
	}
	.moment-tag {
		cursor: pointer;
		margin-left: 0;
	}
	.grow {
		flex: 1;
	}
	.image-grid {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
		margin-top: 10px;
	}
	.image-grid.small .el-image {
		width: 80px;
		height: 80px;
		border-radius: 6px;
	}
	.image-grid .el-image {
		width: 104px;
		height: 104px;
		border-radius: 8px;
	}
	.image-item {
		position: relative;
	}
	.image-remove {
		position: absolute;
		top: -8px;
		right: -8px;
		z-index: 2;
	}
	.upload-trigger {
		width: 104px;
		height: 104px;
		/* 主题 hairline 过淡，默认给明显虚线框 + 浅底，悬浮才换主题色 */
		border: 1.5px dashed rgba(120, 120, 160, 0.45);
		background: rgba(120, 120, 160, 0.06);
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--el-text-color-secondary);
		cursor: pointer;
		transition:
			border-color 0.2s ease,
			background-color 0.2s ease,
			color 0.2s ease;
	}
	.upload-trigger:hover {
		border-color: var(--el-color-primary);
		color: var(--el-color-primary);
	}
	.muted {
		color: var(--el-text-color-secondary);
		font-size: 20px;
	}
</style>
