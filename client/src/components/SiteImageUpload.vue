<script lang="ts">
	/** 模块级拖拽状态（跨实例共享：源列表写、目标列表读） */
	const DND_MIME = "application/x-shirone-banner-image";
	let dragPayload: { uid: string; index: number; src: string } | null = null;
	let uidSeq = 0;
</script>

<script setup lang="ts">
	import { computed, ref, watch } from "vue";
	import { ElMessage } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { UploadRequestOptions } from "element-plus";
	import { mediaApi } from "../api";
	import { previewUrlOf } from "../utils/content-media";

	const props = withDefaults(
		defineProps<{
			/** 上传目标：banner-desktop | banner-mobile | avatar | favicon */
			target: string;
			modelValue: string[];
			multiple?: boolean;
			accept?: string;
		}>(),
		{ multiple: true, accept: ".webp,.png,.jpg,.jpeg,.gif,.avif" },
	);

	const emit = defineEmits<{ (e: "update:modelValue", v: string[]): void }>();
	const uploading = ref(false);

	function isRemote(src: string): boolean {
		return /^https?:\/\//i.test(src);
	}

	function appendSrc(src: string): void {
		emit("update:modelValue", props.multiple ? [...props.modelValue, src] : [src]);
	}

	async function doUpload(options: UploadRequestOptions): Promise<void> {
		uploading.value = true;
		try {
			const r = await mediaApi.siteImage(props.target, options.file as File);
			appendSrc(r.src);
			options.onSuccess(r);
		} catch (e) {
			options.onError(e as unknown as Parameters<typeof options.onError>[0]);
			ElMessage.error((e as Error).message);
		} finally {
			uploading.value = false;
		}
	}

	function removeAt(i: number): void {
		const next = [...props.modelValue];
		next.splice(i, 1);
		emit("update:modelValue", next);
	}

	function move(i: number, delta: number): void {
		const j = i + delta;
		if (j < 0 || j >= props.modelValue.length) return;
		const next = [...props.modelValue];
		[next[i], next[j]] = [next[j], next[i]];
		emit("update:modelValue", next);
	}

	/* ---------- 拖拽：列表内拖动 = 排序，跨列表拖动 = 复制一张过去 ---------- */
	const rootEl = ref<HTMLElement | null>(null);
	/** 实例标识：区分「自己列表内拖」与「从另一端列表拖来」 */
	const uid = `banner-list-${++uidSeq}`;
	const dragOver = ref(false);
	const draggingIndex = ref(-1);

	function onDragStart(i: number, src: string, e: DragEvent): void {
		dragPayload = { uid, index: i, src };
		draggingIndex.value = i;
		if (e.dataTransfer) {
			e.dataTransfer.setData(DND_MIME, JSON.stringify(dragPayload));
			e.dataTransfer.setData("text/plain", src);
			e.dataTransfer.effectAllowed = "copyMove";
		}
	}

	function onDragEnd(): void {
		dragPayload = null;
		dragOver.value = false;
		draggingIndex.value = -1;
	}

	function onDragOver(e: DragEvent): void {
		if (!dragPayload || !e.dataTransfer) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = dragPayload.uid === uid ? "move" : "copy";
		dragOver.value = true;
	}

	function onDragLeave(e: DragEvent): void {
		if (!rootEl.value?.contains(e.relatedTarget as Node | null)) dragOver.value = false;
	}

	/** 落点插入序号：首个中点在指针下方的条目之前，否则追加到末尾 */
	function insertionIndex(e: DragEvent): number {
		const items = rootEl.value?.querySelectorAll<HTMLElement>(".site-image-item") ?? [];
		for (let i = 0; i < items.length; i += 1) {
			const r = items[i].getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) return i;
		}
		return items.length;
	}

	function onDrop(e: DragEvent): void {
		if (!dragPayload) return;
		e.preventDefault();
		const to = insertionIndex(e);
		const from = dragPayload.index;
		const next = [...props.modelValue];
		if (dragPayload.uid === uid) {
			// 同列表排序：to 按含拖拽项的 DOM 计算，移除后回退一位
			const [item] = next.splice(from, 1);
			next.splice(from < to ? to - 1 : to, 0, item);
		} else {
			// 跨列表复制：另一端的 src 插入本列表（本地路径/在线地址均可）
			next.splice(to, 0, dragPayload.src);
		}
		emit("update:modelValue", next);
		dragOver.value = false;
	}

	/* ---------- 在线图片对话框：预览确认后按模式落仓或直引 ---------- */

	type ImportMode = "download" | "link";
	const IMPORT_MODES: { value: ImportMode; icon: string; title: string; desc?: string; recommended: boolean }[] = [
		{
			value: "download",
			icon: "material-symbols:cloud-download",
			title: "下载到内容仓",
			desc: "服务端下载原图存入内容仓，站点不依赖外部地址",
			recommended: true,
		},
		{
			value: "link",
			icon: "material-symbols:link",
			title: "仅在线引用",
			desc: "外站失效或防盗链会导致壁纸无法显示",
			recommended: false,
		},
	];

	const urlVisible = ref(false);
	const urlDraft = ref("");
	/** 防抖后的合法地址：空串表示无可预览内容 */
	const urlPreview = ref("");
	const importMode = ref<ImportMode>("download");
	const importing = ref(false);
	const urlValid = computed(() => /^https?:\/\/\S+$/i.test(urlDraft.value.trim()));
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;

	watch(urlDraft, () => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			urlPreview.value = urlValid.value ? urlDraft.value.trim() : "";
		}, 500);
	});

	function resetUrlDialog(): void {
		urlDraft.value = "";
		urlPreview.value = "";
		importMode.value = "download";
	}

	async function confirmUrlImage(): Promise<void> {
		const url = urlDraft.value.trim();
		if (!urlValid.value || importing.value) return;
		if (importMode.value === "link") {
			appendSrc(url);
			urlVisible.value = false;
			return;
		}
		importing.value = true;
		try {
			const r = await mediaApi.siteImageImport({ target: props.target, url });
			appendSrc(r.src);
			ElMessage.success(`已下载 ${r.fileName} 到内容仓`);
			urlVisible.value = false;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			importing.value = false;
		}
	}
</script>

<template>
	<div
		ref="rootEl"
		class="site-images"
		:class="{ 'drag-over': dragOver }"
		@dragover="onDragOver"
		@dragleave="onDragLeave"
		@drop="onDrop"
	>
		<div
			v-for="(src, i) in modelValue"
			:key="`${src}-${i}`"
			class="site-image-item"
			:class="{ dragging: draggingIndex === i }"
			draggable="true"
			@dragstart="onDragStart(i, src, $event)"
			@dragend="onDragEnd"
		>
			<el-image
				:src="previewUrlOf(src)"
				fit="cover"
				:preview-src-list="[previewUrlOf(src)]"
				preview-teleported
			/>
			<span v-if="isRemote(src)" class="remote-badge">在线</span>
			<div class="site-image-ops">
				<el-button size="small" circle :disabled="i === 0" @click="move(i, -1)">
					<el-icon><ArrowUp /></el-icon>
				</el-button>
				<el-button size="small" circle :disabled="i === modelValue.length - 1" @click="move(i, 1)">
					<el-icon><ArrowDown /></el-icon>
				</el-button>
				<el-button size="small" circle type="danger" @click="removeAt(i)">
					<el-icon><Close /></el-icon>
				</el-button>
			</div>
			<div class="site-image-src" :title="src">{{ src }}</div>
		</div>
		<div v-if="multiple || modelValue.length === 0" class="add-cells">
			<el-upload :show-file-list="false" :http-request="doUpload" :accept="accept" :multiple="multiple">
				<div class="add-tile" :class="{ single: !multiple }">
					<el-icon v-if="!uploading"><Plus /></el-icon>
					<el-icon v-else class="is-loading"><Loading /></el-icon>
					<span v-if="multiple" class="add-tile-label">上传图片</span>
				</div>
			</el-upload>
			<div class="add-tile" :class="{ single: !multiple }" role="button" tabindex="0" @click="urlVisible = true" @keydown.enter="urlVisible = true">
				<el-icon><Link /></el-icon>
				<span v-if="multiple" class="add-tile-label">在线图片</span>
			</div>
		</div>
	</div>

	<el-dialog v-model="urlVisible" title="添加在线图片" width="600px" top="10vh" append-to-body class="url-dialog" @closed="resetUrlDialog">
		<el-input v-model="urlDraft" placeholder="https://…（图片直链，非网页地址）" clearable>
			<template #prefix><el-icon><Link /></el-icon></template>
		</el-input>
		<div class="url-preview">
			<el-image v-if="urlPreview" :key="urlPreview" :src="urlPreview" fit="cover">
				<template #placeholder>
					<div class="preview-hint"><el-icon class="is-loading"><Loading /></el-icon><span>加载预览…</span></div>
				</template>
				<template #error>
					<div class="preview-hint warn">
						<el-icon><WarningFilled /></el-icon>
						<span>预览加载失败：可能有防盗链限制，仍可尝试「下载到内容仓」</span>
					</div>
				</template>
			</el-image>
			<div v-else class="preview-hint"><el-icon><Image /></el-icon><span>粘贴图片直链，此处实时预览</span></div>
		</div>
		<div class="mode-cards">
			<button
				v-for="m in IMPORT_MODES"
				:key="m.value"
				type="button"
				class="mode-card"
				:class="{ active: importMode === m.value }"
				@click="importMode = m.value"
			>
				<el-icon class="mode-icon"><Icon :icon="m.icon" /></el-icon>
				<div class="mode-text">
					<div class="mode-title">
						{{ m.title }}
						<el-tag v-if="m.recommended" size="small" class="mode-tag">推荐</el-tag>
					</div>
					<div class="mode-desc">{{ m.desc }}</div>
				</div>
			</button>
		</div>
		<template #footer>
			<el-button :disabled="importing" @click="urlVisible = false">取消</el-button>
			<el-button type="primary" :loading="importing" :disabled="!urlValid" @click="confirmUrlImage">
				{{ importMode === "download" ? "下载并添加" : "直接添加" }}
			</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
	.site-images {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		align-items: flex-start;
	}
	.site-image-item {
		position: relative;
		width: 168px;
		cursor: grab;
	}
	.site-image-item:active {
		cursor: grabbing;
	}
	.site-image-item.dragging {
		opacity: 0.4;
	}
	/* 缩略图原生拖拽会让位给条目拖拽（否则拖 img 触发浏览器自带拖图） */
	.site-image-item :deep(img) {
		-webkit-user-drag: none;
		user-select: none;
	}
	.site-images.drag-over {
		outline: 2px dashed var(--el-color-primary);
		outline-offset: 8px;
		border-radius: 12px;
	}
	.site-image-item .el-image {
		width: 168px;
		height: 96px;
		border-radius: 10px;
		border: 1px solid var(--glass-border-soft);
	}
	.remote-badge {
		position: absolute;
		top: 6px;
		left: 6px;
		padding: 0 8px;
		border-radius: 999px;
		line-height: 22px;
		font-size: 14px;
		color: #fff;
		background: rgba(0, 0, 0, 0.45);
		backdrop-filter: blur(4px);
	}
	.site-image-ops {
		display: flex;
		gap: 4px;
		margin-top: 4px;
	}
	.site-image-src {
		font-size: 20px;
		color: var(--text-sub);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		margin-top: 2px;
	}
	/* 添加格：上传 / 在线两张同规格虚线格并排 */
	.add-cells {
		display: flex;
		gap: 10px;
	}
	.add-tile {
		width: 168px;
		height: 96px;
		border: 1px dashed var(--el-border-color);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		color: var(--el-text-color-secondary);
		cursor: pointer;
		user-select: none;
	}
	.add-tile:hover,
	.add-tile:focus-visible {
		border-color: var(--el-color-primary);
		color: var(--el-color-primary);
		outline: none;
	}
	.add-tile.single {
		width: 96px;
		height: 96px;
		border-radius: 50%;
	}
	.add-tile-label {
		font-size: 20px;
	}

	/* 在线图片对话框 */
	.url-preview {
		height: 200px;
		margin-top: 12px;
		border: 1px solid var(--glass-border-soft);
		border-radius: 12px;
		overflow: hidden;
		background: var(--el-fill-color-light);
	}
	.url-preview .el-image {
		width: 100%;
		height: 100%;
		display: block;
	}
	.preview-hint {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		font-size: 20px;
		color: var(--text-sub);
		padding: 0 24px;
		text-align: center;
	}
	.preview-hint.warn {
		color: var(--el-color-warning);
	}
	.mode-cards {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 12px;
	}
	.mode-card {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--glass-border-soft);
		border-radius: 12px;
		background: transparent;
		cursor: pointer;
		text-align: left;
		transition:
			border-color 0.2s,
			background-color 0.2s;
	}
	.mode-card:hover {
		border-color: var(--el-color-primary-light-5);
	}
	.mode-card.active {
		border-color: var(--el-color-primary);
		background: var(--el-color-primary-light-9);
	}
	.mode-icon {
		font-size: 24px;
		color: var(--el-color-primary);
		margin-top: 3px;
	}
	.mode-title {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 20px;
		font-weight: 600;
	}
	.mode-tag {
		flex: none;
	}
	.mode-desc {
		font-size: 20px;
		color: var(--text-sub);
		margin-top: 2px;
	}
</style>
