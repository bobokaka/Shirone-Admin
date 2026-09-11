<script lang="ts">
	import type { NavBarLink } from "@shirone-admin/shared";

	/** 全树共享：当前编辑中的导航项与草稿（递归实例共用；单页面仅一棵树） */
	const editingItem = ref<NavBarLink | null>(null);
	/** 新增未落定的条目（弹窗取消时回滚移除，避免空名残留触发保存校验失败） */
	let pendingNew: { list: NavBarLink[]; item: NavBarLink } | null = null;
	/** 预设项行内改名草稿（与 editingItem 配套） */
	const inlineName = ref("");
	/** 行内改名必填校验未通过标记 */
	const inlineError = ref(false);

	interface EditDraft {
		kind: "preset" | "group" | "link";
		name?: string;
		icon?: string;
		url?: string;
		external?: boolean;
	}
	const editDraft = ref<EditDraft | null>(null);
</script>

<script setup lang="ts">
	/**
	 * 导航菜单编辑器（简单目录树）：行悬停浮出「编辑 / 删除」；预设页面名称行内编辑，
	 * 分组 / 自定义链接走弹窗；分组常驻缩进子列表（递归本组件）。
	 * 拖放两套机制解耦：树内移动走 vue-draggable-plus（SortableJS）；
	 * 外部拖入（文章条目 / 预设卡片，见 PostListView）走原生 HTML5 + 自定义 MIME。
	 */
	import { computed, nextTick, ref, type Directive, type Ref } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { useDraggable } from "vue-draggable-plus";
	import DataIcon from "./DataIcon.vue";
	import IconInput from "./IconInput.vue";
	import { NAV_DROP_MIME, navPresetOf, navPresetShort } from "../utils/navPresets";

	const props = withDefaults(
		defineProps<{
			links: NavBarLink[];
			allowGroup?: boolean;
			depth?: number;
			/** Categories 预设节点下动态挂载的虚拟分类节点（仅展示与点击，不写入 yaml） */
			categories?: { value: string; label: string; count: number }[];
			/** 当前过滤中的分类值（虚拟节点高亮） */
			activeCategory?: string;
			/** 选中文章的候选 url（命中的导航行高亮） */
			activeUrls?: string[];
		}>(),
		{ allowGroup: true, depth: 0 },
	);

	const emit = defineEmits<{
		selectCategory: [value: string];
		nodeClick: [item: NavBarLink];
	}>();

	type NavKind = "preset" | "group" | "link";

	function kindOf(item: NavBarLink): NavKind {
		if (item.children) return "group";
		if (item.preset !== undefined) return "preset";
		return "link";
	}

	function iconOf(item: NavBarLink): string {
		if (item.preset !== undefined) return navPresetOf(item.preset)?.icon ?? item.icon ?? "";
		return item.icon || "material-symbols:link";
	}

	function titleOf(item: NavBarLink): string {
		if (item.preset !== undefined || kindOf(item) === "preset") {
			if (item.name) return item.name;
			const meta = navPresetOf(item.preset);
			return meta ? navPresetShort(meta.label) : item.preset || "未选择预设";
		}
		return item.name || "未命名";
	}

	/** Categories 预设节点：其下挂虚拟分类子节点 */
	function isCategoriesNode(item: NavBarLink): boolean {
		return kindOf(item) === "preset" && item.preset === "Categories";
	}

	/** 行点击（行内改名态除外）：交给父级按 url / preset 决定联动 */
	function onRowClick(item: NavBarLink): void {
		if (!isInlineEditing(item)) emit("nodeClick", item);
	}

	/* ---------- 编辑：预设行内改名 / 分组与链接弹窗（全树共享一份状态） ---------- */

	/** 行内输入自动聚焦（el-input 根是 wrapper，聚焦内部 input） */
	const vFocus: Directive<HTMLElement> = {
		mounted: (el) => (el.querySelector("input") ?? el).focus(),
	};

	const editKind = computed<NavKind | null>(() => (editingItem.value ? kindOf(editingItem.value) : null));
	const editTitle = computed(() => (editKind.value === "group" ? "编辑分组" : "编辑链接"));
	const dialogVisible = computed(() => editingItem.value !== null && editKind.value !== "preset");
	/** 按类型取非空草稿，模板分支判空交给 computed */
	const groupDraft = computed(() => (editDraft.value?.kind === "group" ? editDraft.value : null));
	const linkDraft = computed(() => (editDraft.value?.kind === "link" ? editDraft.value : null));
	const canApplyEdit = computed(() => Boolean(editDraft.value?.name?.trim()));

	/** 预设项：本行处于行内改名态 */
	function isInlineEditing(item: NavBarLink): boolean {
		return editingItem.value === item && kindOf(item) === "preset";
	}

	function openEdit(item: NavBarLink): void {
		editingItem.value = item;
		if (kindOf(item) === "preset") {
			// 回显当前显示名（无覆盖时即主题默认名），在默认值上改而非从空值新建
			inlineName.value = titleOf(item);
			inlineError.value = false;
			return;
		}
		editDraft.value =
			kindOf(item) === "group"
				? { kind: "group", name: item.name ?? "", icon: item.icon ?? "" }
				: {
						kind: "link",
						name: item.name ?? "",
						icon: item.icon ?? "",
						url: item.url ?? "",
						external: item.external ?? false,
					};
	}

	/** 预设项的默认名（主题预设表中文短名；未知预设退回原始值） */
	function presetDefaultOf(item: NavBarLink): string {
		const meta = navPresetOf(item.preset);
		return meta ? navPresetShort(meta.label) : item.preset || "";
	}

	/** 预设行内「默认」：输入框恢复为默认名（保存时与默认一致即不写覆盖） */
	function fillDefaultName(item: NavBarLink): void {
		inlineName.value = presetDefaultOf(item);
		inlineError.value = false;
	}

	/** 预设行内「保存」：名称必填且不超过 10 字符；与默认名相同则不写覆盖，保持跟随主题默认 */
	function commitInlineEdit(item: NavBarLink): void {
		if (!isInlineEditing(item)) return;
		const v = inlineName.value.trim();
		if (!v) {
			inlineError.value = true;
			ElMessage.warning("名称不能为空");
			return;
		}
		if (v.length > 10) {
			inlineError.value = true;
			ElMessage.warning("名称不能超过 10 个字符");
			return;
		}
		item.name = v !== presetDefaultOf(item) ? v : undefined;
		editingItem.value = null;
	}

	function applyEdit(): void {
		const item = editingItem.value;
		const d = editDraft.value;
		if (!item || !d || !canApplyEdit.value) return;
		if (d.name !== undefined) item.name = d.name.trim();
		if (d.icon !== undefined) item.icon = d.icon;
		if (d.url !== undefined) item.url = d.url.trim();
		if (d.external !== undefined) item.external = d.external;
		closeEdit();
	}

	/** 删除前二次确认；分组附带子项数提示 */
	async function confirmRemove(label: string, childCount = 0): Promise<boolean> {
		const extra = childCount > 0 ? `（含 ${childCount} 个子项）` : "";
		try {
			await ElMessageBox.confirm(`确定删除「${label}」${extra}？`, "删除导航项", {
				type: "warning",
				confirmButtonText: "删除",
				cancelButtonText: "取消",
			});
			return true;
		} catch {
			return false;
		}
	}

	async function removeItem(i: number): Promise<void> {
		const item = props.links[i];
		if (!item) return;
		if (!(await confirmRemove(titleOf(item), item.children?.length ?? 0))) return;
		props.links.splice(i, 1);
	}

	/** 顶层新增空分组并直接打开编辑弹窗（列头「分组」按钮用） */
	function addAndEditGroup(): void {
		const group: NavBarLink = { name: "", icon: "", children: [] };
		props.links.push(group);
		pendingNew = { list: props.links, item: group };
		openEdit(group);
	}

	/** 顶层新增空自定义链接并直接打开编辑弹窗（列头「链接」按钮用） */
	function addAndEditLink(): void {
		const link: NavBarLink = { name: "", icon: "", url: "" };
		props.links.push(link);
		pendingNew = { list: props.links, item: link };
		openEdit(link);
	}

	/** 关闭编辑弹窗：新增条目仍未命名则回滚移除（应用/取消/esc 同一出口） */
	function closeEdit(): void {
		const item = editingItem.value;
		if (item && pendingNew?.item === item && !item.name?.trim()) {
			const i = pendingNew.list.indexOf(item);
			if (i >= 0) pendingNew.list.splice(i, 1);
		}
		pendingNew = null;
		editingItem.value = null;
	}

	defineExpose({ addAndEditGroup, addAndEditLink });

	/* ---------- 拖拽 ----------
	 * 两套机制完全解耦：
	 * 1) 树内移动：vue-draggable-plus（SortableJS），每层列表一个 Sortable，同 group 跨层自由移动；
	 * 2) 外部拖入（文章条目 / 预设卡，见 PostListView）：原生 HTML5 拖放，dataTransfer 携带
	 *    自定义 MIME 的 JSON，本组件各级列表自行监听 dragover/drop，按行中点插入本层。
	 * 互不依赖：外部拖入不走 Sortable 的克隆/跨列机制。 */

	const rootEl = ref<HTMLElement | null>(null);

	/** 外部原生拖入：允许放置（仅认自家 MIME；嵌套层各自处理，不重复响应） */
	function onNavDragOver(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes(NAV_DROP_MIME)) return;
		if ((e.target as Element | null)?.closest(".nav-list") !== rootEl.value) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
	}

	/** 外部原生拖入释放：解析 JSON，按指针相对各行中点的位置插入本层 */
	function onNavDrop(e: DragEvent): void {
		const raw = e.dataTransfer?.getData(NAV_DROP_MIME);
		if (!raw) return;
		if ((e.target as Element | null)?.closest(".nav-list") !== rootEl.value) return;
		e.preventDefault();
		let item: NavBarLink;
		try {
			item = JSON.parse(raw) as NavBarLink;
		} catch {
			return;
		}
		const root = rootEl.value;
		if (!root) return;
		const rows = [...root.querySelectorAll<HTMLElement>(":scope > .nav-node > .nav-row")];
		let at = rows.length;
		for (let i = 0; i < rows.length; i += 1) {
			const r = rows[i].getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) {
				at = i;
				break;
			}
		}
		props.links.splice(at, 0, item);
	}

	/** 树内跨层移动的落库兜底：库的 add 数据同步不稳定（remove 生效、add 可能丢），
	 *  nextTick 后核对 clonedData 缺失则按事件索引自行插入（已插入则去重跳过） */
	function ensureMoved(evt: { clonedData?: unknown; newDraggableIndex?: number }): void {
		const data = evt.clonedData as NavBarLink | undefined;
		if (!data) return;
		void nextTick(() => {
			if (props.links.includes(data)) return;
			const at = Math.max(
				0,
				Math.min(evt.newDraggableIndex ?? props.links.length, props.links.length),
			);
			props.links.splice(at, 0, data);
		});
	}

	useDraggable<NavBarLink>(
		rootEl,
		// 传普通数组（非 Ref）：库对普通数组走原地 splice，直接作用于 props.links，与父级响应式同源。
		// 注意保持原生 DnD 模式：forceFallback 下库的跨层数据同步会失效（remove 生效、add 丢失）
		props.links as unknown as Ref<NavBarLink[]>,
		{
			group: { name: "shirone-nav", pull: true, put: true },
			draggable: ".nav-node",
			filter: ".nav-row__edit, .nav-sub--cats",
			animation: 150,
			emptyInsertThreshold: 12,
			onAdd(evt) {
				ensureMoved(evt);
			},
		},
	);
</script>

<template>
	<div ref="rootEl" class="nav-list" @dragover="onNavDragOver" @drop="onNavDrop">
		<!-- 稳定 key：节点元素与数据条目跨重渲染保持绑定 -->
		<template v-for="(item, i) in links" :key="item.name ?? item.preset ?? item.url ?? i">
			<div class="nav-node">
				<div
					class="nav-row"
					:class="{ 'nav-row--active': Boolean(item.url) && (activeUrls ?? []).includes(item.url!) }"
					@click="onRowClick(item)"
				>
					<DataIcon :icon="iconOf(item)" :label="titleOf(item)" :size="20" class="nav-row__icon" />
					<el-input
						v-if="isInlineEditing(item)"
						v-model="inlineName"
						v-focus
						class="nav-row__edit"
						:class="{ 'is-error': inlineError }"
						@input="inlineError = false"
						@keydown.enter.prevent="commitInlineEdit(item)"
						@keydown.esc.prevent="editingItem = null"
					/>
					<span v-else class="nav-row__name" :title="titleOf(item)">
						{{ titleOf(item) }}
					</span>
					<span v-if="isInlineEditing(item)" class="nav-row__edit-ops">
						<el-button size="small" circle text @click.stop="fillDefaultName(item)">
							<el-icon><ScaleToOriginal /></el-icon>
						</el-button>
						<el-button size="small" text type="danger" @click.stop="editingItem = null">取消</el-button>
						<el-button size="small" text type="primary" @click.stop="commitInlineEdit(item)">保存</el-button>
					</span>
					<span v-else class="nav-row__ops">
						<el-button size="small" circle text @click.stop="openEdit(item)">
							<el-icon><Edit /></el-icon>
						</el-button>
						<el-button size="small" circle text type="danger" @click.stop="removeItem(i)">
							<el-icon><Close /></el-icon>
						</el-button>
					</span>
				</div>

				<!-- 分组：缩进子列表（递归本组件） -->
				<div v-if="kindOf(item) === 'group' && item.children" class="nav-sub">
					<NavBarLinksEditor
						:links="item.children"
						:allow-group="false"
						:depth="depth + 1"
						:categories="categories"
						:active-category="activeCategory"
						:active-urls="activeUrls"
						@select-category="(v) => emit('selectCategory', v)"
						@node-click="(it) => emit('nodeClick', it)"
					/>
				</div>

				<!-- Categories 预设：动态虚拟分类子节点（不入 yaml；拖拽死区） -->
				<div
					v-if="isCategoriesNode(item) && categories && categories.length"
					class="nav-sub nav-sub--cats"
					@dragover.stop.prevent
					@drop.stop.prevent
				>
					<div
						v-for="c in categories"
						:key="c.value"
						class="cat-row"
						:class="{ 'cat-row--active': c.value === activeCategory }"
						@click="emit('selectCategory', c.value)"
					>
						<span class="cat-row__name">{{ c.label }}</span>
						<span class="cat-row__count muted">{{ c.count }}</span>
					</div>
				</div>
			</div>
		</template>

		<div v-if="!links.length" class="nav-list__empty muted">暂无菜单项</div>

		<!-- 编辑弹窗（分组/链接）：仅根实例渲染一份；预设页面走行内改名 -->
		<el-dialog
			v-if="depth === 0"
			:model-value="dialogVisible"
			:title="editTitle"
			width="500px"
			append-to-body
			@update:model-value="closeEdit"
		>
			<div v-if="groupDraft" class="nav-dialog-body">
				<div class="nav-edit__grid">
					<label class="nav-field">
						<span class="nav-field__label">分组名称</span>
						<el-input v-model="groupDraft.name" placeholder="如：更多" />
					</label>
					<label class="nav-field">
						<span class="nav-field__label">图标</span>
						<IconInput
							:model-value="groupDraft.icon ?? ''"
							:label="groupDraft.name ?? ''"
							@update:model-value="(v: string) => (groupDraft!.icon = v)"
						/>
					</label>
				</div>
				<p v-if="!groupDraft.name?.trim()" class="nav-field__warn">分组名称不能为空</p>
			</div>

			<div v-else-if="linkDraft" class="nav-dialog-body">
				<div class="nav-edit__grid">
					<label class="nav-field">
						<span class="nav-field__label">名称</span>
						<el-input v-model="linkDraft.name" placeholder="导航栏显示的文字" />
					</label>
					<label class="nav-field">
						<span class="nav-field__label">图标</span>
						<IconInput
							:model-value="linkDraft.icon ?? ''"
							:label="linkDraft.name ?? ''"
							@update:model-value="(v: string) => (linkDraft!.icon = v)"
						/>
					</label>
				</div>
				<label class="nav-field">
					<span class="nav-field__label">链接地址</span>
					<el-input v-model="linkDraft.url" placeholder="https://… 或 /path/" />
				</label>
				<el-checkbox
					:model-value="linkDraft.external ?? false"
					@update:model-value="(v: string | number | boolean) => (linkDraft!.external = Boolean(v))"
				>
					外部链接（新标签页打开）
				</el-checkbox>
				<p v-if="!linkDraft.name?.trim()" class="nav-field__warn">名称不能为空</p>
			</div>
			<template #footer>
				<el-button @click="closeEdit">取消</el-button>
				<el-button type="primary" :disabled="!canApplyEdit" @click="applyEdit">确定</el-button>
			</template>
		</el-dialog>
	</div>
</template>

<style scoped>
	.nav-list {
		display: flex;
		flex-direction: column;
	}
	.nav-list__empty {
		padding: 12px 0;
		text-align: center;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-secondary);
	}
	/* 简单目录树：行 + 缩进引导线，无卡片描边 */
	.nav-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 6px;
		border-radius: 6px;
		cursor: grab;
		user-select: none;
		white-space: nowrap;
	}
	.nav-row:hover {
		background: rgba(120, 120, 160, 0.09);
	}
	.nav-row:active {
		cursor: grabbing;
	}
	.nav-row--active {
		background: rgba(99, 102, 241, 0.1);
		box-shadow: inset 2px 0 0 var(--el-color-primary);
	}
	.nav-row__icon {
		flex: none;
		color: var(--el-text-color-secondary);
	}
	.nav-row__name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-primary);
	}
	/* 行内改名输入框：定宽 */
	.nav-row__edit {
		flex: none;
		width: 140px;
	}
	.nav-row__edit.is-error :deep(.el-input__wrapper) {
		box-shadow: 0 0 0 1.5px var(--el-color-danger) inset;
	}
	.nav-row__edit-ops {
		display: inline-flex;
		align-items: center;
		flex: none;
	}
	.nav-row__edit-ops .el-button + .el-button {
		margin-left: 2px;
	}
	.nav-row__ops {
		display: inline-flex;
		align-items: center;
		flex: none;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.nav-row:hover .nav-row__ops,
	.nav-row__ops:focus-within {
		opacity: 1;
	}
	.nav-row__ops .el-button + .el-button {
		margin-left: 2px;
	}
	/* 子级：缩进 + 左侧引导线 */
	.nav-sub {
		margin-left: 14px;
		padding-left: 10px;
		border-left: 1px solid var(--el-border-color-lighter);
	}
	.nav-sub--cats {
		display: flex;
		flex-direction: column;
	}
	.cat-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 6px;
		border-radius: 6px;
		cursor: pointer;
		user-select: none;
	}
	.cat-row:hover {
		background: rgba(120, 120, 160, 0.09);
	}
	.cat-row--active {
		background: rgba(99, 102, 241, 0.12);
	}
	.cat-row__name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.cat-row__count {
		flex: none;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	/* SortableJS：占位虚化指示 */
	.nav-node.sortable-ghost {
		opacity: 0.4;
		outline: 1px dashed var(--el-color-primary);
		border-radius: 6px;
	}
	/* 编辑弹窗表单 */
	.nav-dialog-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.nav-edit__grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 10px 12px;
	}
	.nav-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.nav-field__label {
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-secondary);
		line-height: 1;
	}
	.nav-field__warn {
		margin: 0;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-color-danger);
	}
</style>
