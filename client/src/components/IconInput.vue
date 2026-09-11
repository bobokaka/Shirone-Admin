<script setup lang="ts">
	/**
	 * 图标字段输入：仅展示当前图标，右侧「选择」按钮打开「图标库」弹窗
	 * （内置离线集合，按集合前缀与名称关键字筛选点选，每页 240 个分页浏览）。
	 * 弹窗底部「图片路径」与图标库选中互斥：点库图标清空路径输入，输入/上传图片即接管草稿；
	 * 支持本地文件选择与直接粘贴图片上传（落内容仓 public/images/icons/），右侧实时预览加载成败。
	 * 值仍为 Iconify 名（material-symbols:web）或图片路径（/images/…）。
	 */
	import { computed, ref, watch } from "vue";
	import { ElMessage } from "element-plus";
	import DataIcon from "./DataIcon.vue";
	import { mediaApi } from "../api";
	import { contentPreviewUrl } from "../utils/assets";
	import { BUNDLED_COLLECTIONS, hasLocalIcon } from "../utils/icons";

	const props = withDefaults(
		defineProps<{
			modelValue: string;
			placeholder?: string;
			/** 首字母兜底用的文本 */
			label?: string;
		}>(),
		{ placeholder: "", label: "" },
	);

	const emit = defineEmits<{ "update:modelValue": [value: string] }>();

	const visible = ref(false);
	/** 弹窗内草稿：确定才落值到字段 */
	const draft = ref(props.modelValue);
	/** 名称筛选关键字 */
	const query = ref("");
	/** 集合筛选：all 或前缀 */
	const scope = ref<string>("all");
	/** 分页：每页 240 个图标 */
	const PAGE_SIZE = 240;
	const page = ref(1);
	const gridEl = ref<HTMLElement | null>(null);
	/** 图片路径输入（库外值）：与图标库选中互斥，后操作者生效 */
	const manual = ref("");
	const uploading = ref(false);
	const fileInputEl = ref<HTMLInputElement | null>(null);
	/** 路径预览图加载失败态（路径无效 / 外站不可达时给可见反馈） */
	const manualFailed = ref(false);

	watch(visible, (v) => {
		if (!v) return;
		draft.value = props.modelValue;
		query.value = "";
		scope.value = "all";
		page.value = 1;
		manual.value = isLibIcon(props.modelValue) ? "" : props.modelValue;
		manualFailed.value = false;
	});
	watch([query, scope], () => {
		page.value = 1;
	});
	watch(page, () => gridEl.value?.scrollTo({ top: 0 }));

	/** 名字归一化比较（忽略连字符 / 下划线 / 大小写） */
	function norm(s: string): string {
		return s.toLowerCase().replace(/[\s_-]/g, "");
	}

	const matches = computed(() => {
		const q = norm(query.value.trim());
		const out: string[] = [];
		for (const col of BUNDLED_COLLECTIONS) {
			if (scope.value !== "all" && col.prefix !== scope.value) continue;
			for (const n of col.names) {
				if (!q || norm(n).includes(q)) out.push(`${col.prefix}:${n}`);
			}
		}
		return out;
	});
	const shown = computed(() => {
		const start = (page.value - 1) * PAGE_SIZE;
		return matches.value.slice(start, start + PAGE_SIZE);
	});

	const scopeOptions = [
		{ label: "全部", value: "all" },
		...BUNDLED_COLLECTIONS.map((c) => ({ label: c.prefix, value: c.prefix })),
	];

	function confirmPick(): void {
		emit("update:modelValue", draft.value.trim());
		visible.value = false;
	}

	/** 值是否为内置图标库中的 Iconify 名（这类值不进图片路径输入框） */
	function isLibIcon(v: string): boolean {
		return /^[\w-]+:[\w-]+$/.test(v) && hasLocalIcon(v);
	}

	/** 选中库内图标：接管草稿并清空图片路径（两者互斥） */
	function pickTile(name: string): void {
		draft.value = name;
		manual.value = "";
		manualFailed.value = false;
	}

	/** 图片路径输入实时接管草稿（图标库高亮随之自动消失） */
	function syncManual(): void {
		draft.value = manual.value;
		manualFailed.value = false;
	}

	const manualPreviewSrc = computed(() => {
		const v = manual.value.trim();
		if (!v) return undefined;
		if (!/^https?:\/\//.test(v) && !v.startsWith("/")) return undefined;
		return contentPreviewUrl(v);
	});

	/** 粘贴图片直接上传；粘贴文本走默认行为，由 input 事件同步草稿 */
	function onManualPaste(e: ClipboardEvent): void {
		const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith("image/"));
		if (!file) return;
		e.preventDefault();
		void uploadIconFile(file);
	}

	async function uploadIconFile(file: File): Promise<void> {
		if (!file.type.startsWith("image/") && !/\.(svg|ico)$/i.test(file.name)) {
			ElMessage.warning("请选择图片文件（png / jpg / webp / gif / svg / ico）");
			return;
		}
		uploading.value = true;
		try {
			const current = manual.value.trim();
			const r = await mediaApi.iconImage(file, current.startsWith("/images/icons/") ? current : undefined);
			manual.value = r.src;
			draft.value = r.src;
			manualFailed.value = false;
			ElMessage.success(`已上传 ${r.fileName}`);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			uploading.value = false;
		}
	}

	function onFileChosen(e: Event): void {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = "";
		if (file) void uploadIconFile(file);
	}
</script>

<template>
	<div class="icon-input">
		<button
			type="button"
			class="icon-input__preview"
			:title="modelValue || placeholder || '未设置图标'"
			@click="visible = true"
		>
			<DataIcon v-if="modelValue" :icon="modelValue" :label="label" :size="26" />
			<el-icon v-else :size="24"><Grid /></el-icon>
		</button>
		<el-button class="icon-input__pick" title="打开图标库" @click="visible = true">选择</el-button>
		<el-button
			v-if="modelValue"
			size="small"
			circle
			text
			type="danger"
			title="清除图标"
			@click="emit('update:modelValue', '')"
		>
			<el-icon><CircleClose /></el-icon>
		</el-button>
	</div>

	<el-dialog v-model="visible" title="选择图标" width="906px" append-to-body>
		<div class="picker-head">
			<el-input v-model="query" placeholder="按名称筛选（如 home / github）" clearable>
				<template #prefix><el-icon><Search /></el-icon></template>
			</el-input>
			<el-segmented v-model="scope" :options="scopeOptions" />
		</div>
		<div ref="gridEl" class="picker-grid">
			<button
				v-for="name in shown"
				:key="name"
				type="button"
				class="picker-tile"
				:class="{ 'picker-tile--on': name === draft }"
				:title="name"
				@click="pickTile(name)"
				@dblclick="confirmPick()"
			>
				<DataIcon :icon="name" :size="48" fallback="none" />
			</button>
			<div v-if="!shown.length" class="picker-empty muted">无匹配图标</div>
		</div>
		<div class="picker-page">
			<span class="picker-page__total muted">共 {{ matches.length }} 个</span>
			<el-pagination
				v-model:current-page="page"
				background
				:page-size="PAGE_SIZE"
				:pager-count="7"
				:total="matches.length"
				layout="prev, pager, next"
			/>
		</div>
		<div class="picker-manual">
			<span class="picker-manual__label">图片路径</span>
			<el-button
				class="picker-manual__upload"
				:loading="uploading"
				title="选择本地图片文件上传为图标"
				@click="fileInputEl?.click()"
			>
				<el-icon><FolderOpened /></el-icon>
				<span>选择文件</span>
			</el-button>
			<el-input
				v-model="manual"
				class="picker-manual__input"
				placeholder="图片路径 / URL（/images/…、https://…），可直接粘贴图片"
				clearable
				@input="syncManual"
				@clear="syncManual"
				@paste="onManualPaste"
			/>
			<span
				class="picker-manual__preview"
				:class="{ 'is-failed': manualPreviewSrc && manualFailed }"
				:title="manualPreviewSrc ? (manualFailed ? '图片加载失败' : '路径预览') : ''"
			>
				<img
					v-if="manualPreviewSrc && !manualFailed"
					:src="manualPreviewSrc"
					alt=""
					@error="manualFailed = true"
				/>
				<el-icon v-else-if="manualPreviewSrc"><PictureFilled /></el-icon>
				<el-icon v-else class="is-empty"><PictureFilled /></el-icon>
			</span>
			<input
				ref="fileInputEl"
				type="file"
				accept="image/*,.svg,.ico"
				hidden
				@change="onFileChosen"
			/>
		</div>
		<template #footer>
			<div class="picker-foot">
				<span class="picker-picked">
					<DataIcon :icon="draft" :label="label" :size="24" />
					<span class="picker-picked__name">{{ draft || "未选择" }}</span>
				</span>
				<span class="grow"></span>
				<el-button @click="visible = false">取消</el-button>
				<el-button type="primary" @click="confirmPick">确定</el-button>
			</div>
		</template>
	</el-dialog>
</template>

<style scoped>
	.icon-input {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.icon-input__preview {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 1px solid var(--el-border-color);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.6);
		color: var(--el-text-color-secondary);
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.icon-input__preview:hover {
		border-color: var(--el-color-primary);
	}
	.icon-input__pick {
		flex: none;
		height: 40px;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	/* 弹窗：筛选头 + 网格 + 库外值兜底 */
	.picker-head {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}
	.picker-head .el-input {
		flex: 1;
	}
	.picker-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
		gap: 8px;
		max-height: 56vh;
		overflow-y: auto;
		padding: 8px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 10px;
	}
	.picker-tile {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 84px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 10px;
		background: transparent;
		cursor: pointer;
		color: var(--el-text-color-regular);
	}
	.picker-tile:hover {
		background: rgba(99, 102, 241, 0.08);
	}
	.picker-tile--on {
		border-color: var(--el-color-primary);
		background: rgba(99, 102, 241, 0.1);
	}
	.picker-empty {
		grid-column: 1 / -1;
		padding: 24px 0;
		text-align: center;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.picker-page {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-top: 10px;
	}
	.picker-page__total {
		flex: none;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.picker-page :deep(.el-pagination) {
		--el-pagination-font-size: calc(20px + var(--font-shift, 0px));
		--el-pagination-button-width: 36px;
		--el-pagination-button-height: 36px;
	}
	.picker-manual {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}
	.picker-manual__label {
		flex: none;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-secondary);
	}
	.picker-manual__upload {
		flex: none;
		height: 40px;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.picker-manual__input {
		flex: 1;
		min-width: 0;
	}
	.picker-manual__preview {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 40px;
		height: 40px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		background: rgba(128, 128, 150, 0.08);
		color: var(--el-text-color-secondary);
		overflow: hidden;
	}
	.picker-manual__preview img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.picker-manual__preview .is-empty {
		opacity: 0.5;
	}
	.picker-manual__preview.is-failed {
		border-color: var(--el-color-danger);
		color: var(--el-color-danger);
	}
	.picker-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
	}
	.picker-picked {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.picker-picked__name {
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-regular);
	}
	.grow {
		flex: 1;
	}
</style>
