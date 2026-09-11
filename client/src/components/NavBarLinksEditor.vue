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
	/** 行内重命名中的分类节点值与草稿（全树共享；分类节点可能渲染于任一递归实例内） */
	const editingCat = ref<string | null>(null);
	const catName = ref("");
	const catError = ref(false);
	/** 文章拖拽悬停的分类节点值（放置高亮；全树共享同上） */
	const droppingCat = ref<string | null>(null);
	/** 折叠中的节点键（全树共享 UI 态）：存独立集合而非 NavBarLink 对象，避免触发深层 watch 的自动保存 */
	const collapsedKeys = ref<Set<string>>(new Set());

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
	 * 导航菜单编辑器（卡片树）：行悬停浮出「编辑 / 删除」；预设页面名称行内编辑，
	 * 分组 / 自定义链接走弹窗；分组常驻缩进子列表（递归本组件）。
	 * 拖放两套机制解耦：树内移动走 vue-draggable-plus（SortableJS）；
	 * 外部拖入（文章条目 / 预设卡片，见 PostListView）走原生 HTML5 + 自定义 MIME。
	 */
	import { computed, nextTick, onMounted, onUnmounted, ref, type Directive, type Ref } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { useDraggable } from "vue-draggable-plus";
	import DataIcon from "./DataIcon.vue";
	import IconInput from "./IconInput.vue";
	import { NAV_DROP_MIME, POST_DROP_MIME, UNCATEGORIZED, navPresetOf, navPresetShort } from "../utils/navPresets";

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
		/** 分类节点行内改名（改写该分类全部文章的 frontmatter，API 与刷新由父级处理） */
		renameCategory: [from: string, to: string];
		/** 文章拖入分类节点改该文分类（未分类哨兵 = 清空） */
		assignCategory: [categoryValue: string, postPath: string];
	}>();

	type NavKind = "preset" | "group" | "link";

	/** 类型徽标文案（行尾小标签） */
	const KIND_LABEL: Record<NavKind, string> = { preset: "预设", group: "分组", link: "链接" };

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

	/** 未分类哨兵节点（置顶独立展示，不挂在 Categories 下） */
	const uncatNode = computed(
		() => (props.categories ?? []).find((c) => c.value === UNCATEGORIZED) ?? null,
	);
	/** Categories 下的真实分类清单（剔除置顶的未分类哨兵） */
	const realCategories = computed(() =>
		(props.categories ?? []).filter((c) => c.value !== UNCATEGORIZED),
	);

	/* ---------- 展开 / 收起（分组子列表与 Categories 分类树） ---------- */

	/** 折叠态节点的稳定键（Categories 预设用固定哨兵，分组按名） */
	function collapseKeyOf(item: NavBarLink): string {
		return isCategoriesNode(item) ? "preset:Categories" : `group:${item.name ?? ""}`;
	}

	/** 行是否可展开：分组有子项 / Categories 预设下挂真实分类 */
	function isExpandable(item: NavBarLink): boolean {
		if (isCategoriesNode(item)) return realCategories.value.length > 0;
		return kindOf(item) === "group" && Boolean(item.children?.length);
	}

	function isCollapsed(item: NavBarLink): boolean {
		return collapsedKeys.value.has(collapseKeyOf(item));
	}

	/** 整体替换集合保证响应式（Set 原地变更不会被 ref 感知） */
	function toggleCollapse(item: NavBarLink): void {
		const key = collapseKeyOf(item);
		const next = new Set(collapsedKeys.value);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		collapsedKeys.value = next;
	}

	/** 行点击（行内改名态除外）：交给父级按 url / preset 决定联动 */
	function onRowClick(item: NavBarLink): void {
		if (!isInlineEditing(item)) emit("nodeClick", item);
	}

	/* ---------- 分类虚拟节点：行内重命名 + 文章拖入改分类 ---------- */

	/** 分类行点击：改名态不联动过滤 */
	function onCatRowClick(c: { value: string }): void {
		if (editingCat.value !== c.value) emit("selectCategory", c.value);
	}

	/** 开启行内重命名：回显当前分类名 */
	function openCatEdit(c: { value: string; label: string }): void {
		editingCat.value = c.value;
		catName.value = c.label;
		catError.value = false;
	}

	/** 行内重命名保存：非空且确有修改才上抛 */
	function commitCatEdit(c: { value: string; label: string }): void {
		const v = catName.value.trim();
		if (!v) {
			catError.value = true;
			ElMessage.warning("分类名不能为空");
			return;
		}
		if (v !== c.label) emit("renameCategory", c.label, v);
		editingCat.value = null;
	}

	/** 未分类虚拟节点点击：切换未分类过滤 */
	function onUncatClick(): void {
		emit("selectCategory", UNCATEGORIZED);
	}

	/** 文章拖过分类行：仅认文章 MIME，亮放置高亮；阻断冒泡并熄掉本层导航插入线（落点语义已切换） */
	function onCatDragOver(value: string, e: DragEvent): void {
		if (!e.dataTransfer?.types.includes(POST_DROP_MIME)) return;
		e.preventDefault();
		e.stopPropagation();
		e.dataTransfer.dropEffect = "copy";
		droppingCat.value = value;
		dropLineTop.value = null;
	}

	function onCatDragLeave(): void {
		droppingCat.value = null;
	}

	/** 文章释放在分类行：上抛改分类；阻断冒泡，避免同拖的导航 MIME 再触发插入 */
	function onCatDrop(value: string, e: DragEvent): void {
		const raw = e.dataTransfer?.getData(POST_DROP_MIME);
		droppingCat.value = null;
		if (!raw) return;
		e.preventDefault();
		e.stopPropagation();
		let post: { path?: string };
		try {
			post = JSON.parse(raw) as { path?: string };
		} catch {
			return;
		}
		if (!post.path) return;
		emit("assignCategory", value, post.path);
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
	/** 蓝色放置指示线在本层列表盒内的 top（null = 不显示） */
	const dropLineTop = ref<number | null>(null);

	/** 本层插入序号：指针在各行中点上方即插到该行之前，末行之后返回 length */
	function insertionIndexAt(y: number): number {
		const root = rootEl.value;
		if (!root) return props.links.length;
		const rows = [...root.querySelectorAll<HTMLElement>(":scope > .nav-node > .nav-row")];
		for (let i = 0; i < rows.length; i += 1) {
			const r = rows[i].getBoundingClientRect();
			if (y < r.top + r.height / 2) return i;
		}
		return rows.length;
	}

	/** 指示线 top（相对本层列表盒）：插入点即下一行顶缘，末位为上一行底缘（线高 3px 居中压在缝上） */
	function dropLineTopAt(y: number): number {
		const root = rootEl.value;
		if (!root) return 0;
		const rootTop = root.getBoundingClientRect().top;
		const rows = [...root.querySelectorAll<HTMLElement>(":scope > .nav-node > .nav-row")];
		if (!rows.length) return 2;
		const at = insertionIndexAt(y);
		const ref = at < rows.length ? rows[at] : rows[rows.length - 1];
		const r = ref.getBoundingClientRect();
		return (at < rows.length ? r.top : r.bottom) - rootTop - 1.5;
	}

	/** 外部原生拖入：允许放置并亮指示线（仅认自家 MIME；嵌套层各自处理，指针转入子层时本层熄线） */
	function onNavDragOver(e: DragEvent): void {
		if (!e.dataTransfer?.types.includes(NAV_DROP_MIME)) return;
		if ((e.target as Element | null)?.closest(".nav-list") !== rootEl.value) {
			dropLineTop.value = null;
			return;
		}
		e.preventDefault();
		e.dataTransfer.dropEffect = "copy";
		dropLineTop.value = dropLineTopAt(e.clientY);
	}

	/** 拖出本层列表（relatedTarget 已不在列表内）时熄线；移入子元素不算离开 */
	function onNavDragLeave(e: DragEvent): void {
		const to = e.relatedTarget as Node | null;
		if (to && rootEl.value?.contains(to)) return;
		dropLineTop.value = null;
	}

	/** 外部原生拖入释放：解析 JSON，按插入序号落位本层 */
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
		props.links.splice(insertionIndexAt(e.clientY), 0, item);
		dropLineTop.value = null;
	}

	/** 拖拽结束的兜底熄灭（释放在列表外时没有 drop/dragleave 到本层）：document 捕获 + dragend */
	const clearDropUi = (): void => {
		dropLineTop.value = null;
		droppingCat.value = null;
	};
	onMounted(() => {
		document.addEventListener("drop", clearDropUi, true);
		document.addEventListener("dragend", clearDropUi);
	});
	onUnmounted(() => {
		document.removeEventListener("drop", clearDropUi, true);
		document.removeEventListener("dragend", clearDropUi);
	});

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
			filter: ".nav-row__edit, .nav-sub--cats, .nav-row__toggle",
			animation: 150,
			emptyInsertThreshold: 12,
			onAdd(evt) {
				ensureMoved(evt);
			},
		},
	);
</script>

<template>
	<div
		ref="rootEl"
		class="nav-list"
		@dragover="onNavDragOver"
		@dragleave="onNavDragLeave"
		@drop="onNavDrop"
	>
		<!-- 未分类虚拟节点：置顶于首页之前（不入 yaml、不参与排序；点击过滤、拖入文章=清空分类） -->
		<div v-if="depth === 0 && uncatNode" class="nav-virtual">
			<div
				class="nav-row nav-row--uncat"
				:class="{
					'nav-row--active': activeCategory === UNCATEGORIZED,
					'nav-row--drop': droppingCat === UNCATEGORIZED,
				}"
				title="未分类文章；拖入文章即清空其分类"
				@click="onUncatClick"
				@dragover="onCatDragOver(UNCATEGORIZED, $event)"
				@dragleave="onCatDragLeave"
				@drop="onCatDrop(UNCATEGORIZED, $event)"
			>
				<span class="nav-row__toggle-spacer" aria-hidden="true"></span>
				<DataIcon
					icon="material-symbols:folder-outline-rounded"
					:size="20"
					class="nav-row__icon"
				/>
				<span class="nav-row__name">未分类</span>
				<span class="nav-row__kind">分类</span>
				<span class="nav-row__count muted">{{ uncatNode.count }}</span>
			</div>
		</div>

		<!-- 稳定 key：节点元素与数据条目跨重渲染保持绑定 -->
		<template v-for="(item, i) in links" :key="item.name ?? item.preset ?? item.url ?? i">
			<div class="nav-node">
				<div
					class="nav-row"
					:class="[
						`nav-row--${kindOf(item)}`,
						{ 'nav-row--active': Boolean(item.url) && (activeUrls ?? []).includes(item.url!) },
					]"
					@click="onRowClick(item)"
				>
					<span
						v-if="isExpandable(item)"
						class="nav-row__toggle"
						:class="{ 'is-open': !isCollapsed(item) }"
						:title="isCollapsed(item) ? '展开子项' : '收起子项'"
						@click.stop="toggleCollapse(item)"
					>
						<el-icon :size="16"><ArrowRight /></el-icon>
					</span>
					<span v-else class="nav-row__toggle-spacer" aria-hidden="true"></span>
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
					<span class="nav-row__kind">{{ KIND_LABEL[kindOf(item)] }}</span>
					<span v-if="isInlineEditing(item)" class="nav-row__edit-ops">
						<el-button
							size="small"
							circle
							text
							class="nav-row__reset"
							title="恢复默认名"
							@click.stop="fillDefaultName(item)"
						>
							<el-icon><RefreshLeft /></el-icon>
						</el-button>
						<el-button size="small" text type="danger" @click.stop="editingItem = null">取消</el-button>
						<el-button size="small" type="primary" @click.stop="commitInlineEdit(item)">保存</el-button>
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

				<!-- 分组：缩进子列表（递归本组件；可折叠） -->
				<div v-if="kindOf(item) === 'group' && item.children && !isCollapsed(item)" class="nav-sub">
					<NavBarLinksEditor
						:links="item.children"
						:allow-group="false"
						:depth="depth + 1"
						:categories="categories"
						:active-category="activeCategory"
						:active-urls="activeUrls"
						@select-category="(v) => emit('selectCategory', v)"
						@node-click="(it) => emit('nodeClick', it)"
						@rename-category="(from, to) => emit('renameCategory', from, to)"
						@assign-category="(value, path) => emit('assignCategory', value, path)"
					/>
				</div>

				<!-- Categories 预设：动态虚拟分类子节点（未分类哨兵已置顶，此处仅真实分类） -->
				<div
					v-if="isCategoriesNode(item) && realCategories.length && !isCollapsed(item)"
					class="nav-sub nav-sub--cats"
					@dragover.stop.prevent
					@drop.stop.prevent
				>
					<div
						v-for="c in realCategories"
						:key="c.value"
						class="cat-row"
						:class="{
							'cat-row--active': c.value === activeCategory,
							'cat-row--drop': c.value === droppingCat,
						}"
						@click="onCatRowClick(c)"
						@dragover="onCatDragOver(c.value, $event)"
						@dragleave="onCatDragLeave"
						@drop="onCatDrop(c.value, $event)"
					>
						<el-input
							v-if="editingCat === c.value"
							v-model="catName"
							v-focus
							class="cat-row__edit"
							:class="{ 'is-error': catError }"
							@input="catError = false"
							@keydown.enter.prevent="commitCatEdit(c)"
							@keydown.esc.prevent="editingCat = null"
						/>
						<span v-else class="cat-row__name">{{ c.label }}</span>
						<span class="cat-row__count muted">{{ c.count }}</span>
						<span v-if="editingCat === c.value" class="cat-row__ops">
							<el-button size="small" text type="danger" @click.stop="editingCat = null">
								取消
							</el-button>
							<el-button size="small" type="primary" @click.stop="commitCatEdit(c)">保存</el-button>
						</span>
						<!-- 操作区常驻占位（未分类不可改名，留空但对齐计数列） -->
						<span v-else class="cat-row__ops">
							<el-button
								v-if="c.value !== UNCATEGORIZED"
								size="small"
								circle
								text
								title="重命名分类"
								@click.stop="openCatEdit(c)"
							>
								<el-icon><Edit /></el-icon>
							</el-button>
						</span>
					</div>
				</div>
			</div>
		</template>

		<div v-if="!links.length" class="nav-list__empty muted">暂无菜单项</div>

		<!-- 外部拖入的蓝色放置指示线（绝对定位不挤动行位） -->
		<div v-if="dropLineTop !== null" class="nav-drop-line" :style="{ top: `${dropLineTop}px` }"></div>

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
		position: relative; /* 放置指示线的定位基 */
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	/* 外部拖入时的插入位置指引：蓝色横线 + 同色柔光 */
	.nav-drop-line {
		position: absolute;
		left: 6px;
		right: 6px;
		height: 3px;
		border-radius: 2px;
		background: var(--el-color-primary);
		box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.18);
		pointer-events: none;
		z-index: 1;
	}
	.nav-list__empty {
		padding: 12px 0;
		text-align: center;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-secondary);
	}
	/* 卡片树：白玻璃卡片 + 左缘类型色条；类型色经 --nav-accent 下发
	   （预设=橙 与预设卡片弹层同色、分组=极光紫、自定义链接=绿） */
	.nav-row {
		--nav-accent: var(--el-text-color-secondary);
		--nav-accent-border: rgba(120, 120, 160, 0.32);
		--nav-tag-border: rgba(120, 120, 160, 0.5);
		/* 名称/图标用色：默认跟类型色（自定义链接覆盖为黑色） */
		--nav-text: var(--nav-accent);
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 5px 8px 5px 12px;
		border: 1px solid var(--hairline);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.55);
		box-shadow: inset 3px 0 0 var(--nav-accent);
		cursor: grab;
		user-select: none;
		white-space: nowrap;
		transition:
			border-color 0.15s,
			background-color 0.15s;
	}
	.nav-row--preset {
		--nav-accent: var(--el-color-warning);
		--nav-accent-border: rgba(230, 162, 60, 0.45);
		--nav-tag-border: rgba(230, 162, 60, 0.65);
	}
	.nav-row--group {
		--nav-accent: var(--accent-b);
		--nav-accent-border: rgba(168, 85, 247, 0.4);
		--nav-tag-border: rgba(168, 85, 247, 0.6);
	}
	.nav-row--link {
		--nav-accent: var(--el-color-success);
		--nav-accent-border: rgba(103, 194, 58, 0.4);
		--nav-tag-border: rgba(103, 194, 58, 0.6);
		/* 链接行名称/图标用黑色，类型感只留左缘条与徽标 */
		--nav-text: var(--el-text-color-primary);
	}
	/* 未分类置顶虚拟节点：靛蓝色系（与选中态同族），悬停即显色 */
	.nav-row--uncat {
		--nav-accent: #6366f1;
		--nav-accent-border: rgba(99, 102, 241, 0.45);
		--nav-tag-border: rgba(99, 102, 241, 0.6);
		--nav-text: var(--el-text-color-primary);
	}
	.nav-row:hover {
		border-color: var(--nav-accent-border);
		background: rgba(255, 255, 255, 0.72);
	}
	.nav-row:active {
		cursor: grabbing;
	}
	/* 命中当前文章：靛蓝选中态覆盖类型色 */
	.nav-row--active {
		background: rgba(99, 102, 241, 0.1);
		border-color: rgba(99, 102, 241, 0.4);
		box-shadow: inset 3px 0 0 var(--el-color-primary);
	}
	/* 加一档优先级：压过 DataIcon 自身的 .data-icon 默认色（同为单类选择器会受打包顺序影响） */
	.nav-row .nav-row__icon {
		flex: none;
		color: var(--nav-text);
	}
	/* 展开收起箭头：行首常驻（折叠朝右、展开旋下）；占位符等宽保持各行图标纵向对齐 */
	.nav-row__toggle {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		margin-left: -4px;
		border-radius: 5px;
		color: var(--el-text-color-secondary);
		cursor: pointer;
	}
	.nav-row__toggle:hover {
		color: var(--nav-text);
		background: rgba(120, 120, 160, 0.14);
	}
	.nav-row__toggle .el-icon {
		transition: transform 0.15s;
	}
	.nav-row__toggle.is-open .el-icon {
		transform: rotate(90deg);
	}
	.nav-row__toggle-spacer {
		flex: none;
		width: 16px;
	}
	/* 名称与图标同色（预设/分组跟类型色，自定义链接为黑色） */
	.nav-row__name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--nav-text);
	}
	/* 类型徽标：边框型胶囊（透明底 + 类型色描边与文字，辅助微件允许小字号） */
	.nav-row__kind {
		flex: none;
		padding: 0 7px;
		border: 1px solid var(--nav-tag-border);
		border-radius: 999px;
		background: transparent;
		color: var(--nav-accent);
		font-size: 14px;
		line-height: 18px;
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
	/* 恢复默认按钮：图标放大一档，避免小圆钮里看不清 */
	.nav-row__reset :deep(.el-icon) {
		font-size: 18px;
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
	/* 未分类置顶虚拟节点：徽标后的计数列 */
	.nav-row__count {
		flex: none;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	/* 分类行/未分类节点接收文章拖入：蓝色放置高亮（保留左缘类型条） */
	.nav-row--drop {
		border-color: var(--el-color-primary);
		background: rgba(64, 158, 255, 0.12);
		box-shadow:
			inset 3px 0 0 var(--el-color-primary),
			0 0 0 3px rgba(64, 158, 255, 0.15);
	}
	/* 子级：缩进 + 左侧引导线（卡片之间由 .nav-list 的 gap 分隔） */
	.nav-sub {
		margin: 6px 0 2px 14px;
		padding-left: 10px;
		border-left: 1px solid var(--el-border-color-lighter);
	}
	.nav-sub--cats {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	/* 虚拟分类节点：轻量小卡片（不入 yaml，跟随 Categories 预设的缩进层） */
	.cat-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 10px;
		border: 1px solid transparent;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.4);
		cursor: pointer;
		user-select: none;
	}
	/* 分类行悬停：靛蓝显色（选中态的浅一档），明确落点 */
	.cat-row:hover {
		border-color: rgba(99, 102, 241, 0.35);
		background: rgba(99, 102, 241, 0.07);
	}
	.cat-row--active {
		background: rgba(99, 102, 241, 0.12);
		border-color: rgba(99, 102, 241, 0.35);
	}
	/* 文章拖入分类行：放置高亮（与导航蓝线同色系） */
	.cat-row--drop {
		border-color: var(--el-color-primary);
		background: rgba(64, 158, 255, 0.12);
		box-shadow: 0 0 0 3px rgba(64, 158, 255, 0.15);
	}
	/* 分类行内改名：输入框占满余宽，操作按钮悬停浮出（同导航行） */
	.cat-row__edit {
		flex: 1;
		min-width: 0;
	}
	.cat-row__edit.is-error :deep(.el-input__wrapper) {
		box-shadow: 0 0 0 1.5px var(--el-color-danger) inset;
	}
	.cat-row__ops {
		display: inline-flex;
		align-items: center;
		justify-content: flex-end;
		/* 常驻占位与单圆钮等宽：无按钮的行（未分类）计数列也对齐 */
		min-width: 26px;
		flex: none;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.cat-row:hover .cat-row__ops,
	.cat-row__ops:focus-within {
		opacity: 1;
	}
	.cat-row__ops .el-button + .el-button {
		margin-left: 2px;
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
		border-radius: 10px;
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
