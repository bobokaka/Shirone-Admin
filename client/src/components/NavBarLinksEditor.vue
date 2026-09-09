<script setup lang="ts">
	/**
	 * 导航菜单编辑器：列表只显示图标与中文名（分组收起时露出只读子树），
	 * 点击行二次进入编辑；拖行头排序（可拖入其他分组），分组递归本组件。
	 */
	import { ref } from "vue";
	import type { NavBarLink } from "@shirone-admin/shared";
	import DataIcon from "./DataIcon.vue";
	import IconInput from "./IconInput.vue";
	import { NAV_PRESETS, navPresetOf } from "../utils/navPresets";

	const props = withDefaults(defineProps<{ links: NavBarLink[]; allowGroup?: boolean }>(), {
		allowGroup: true,
	});

	type NavKind = "preset" | "group" | "link";

	const KIND_META: Record<NavKind, { label: string; tag: "info" | "warning" | "success" }> = {
		preset: { label: "内置页面", tag: "info" },
		group: { label: "分组", tag: "warning" },
		link: { label: "自定义链接", tag: "success" },
	};

	function kindOf(item: NavBarLink): NavKind {
		if (item.children) return "group";
		if (item.preset !== undefined) return "preset";
		return "link";
	}

	function iconOf(item: NavBarLink): string {
		if (kindOf(item) === "preset") return navPresetOf(item.preset)?.icon ?? "";
		return item.icon ?? "";
	}

	function titleOf(item: NavBarLink): string {
		if (kindOf(item) === "preset") {
			const meta = navPresetOf(item.preset);
			return meta ? meta.label : item.preset || "未选择预设";
		}
		return item.name || "未命名";
	}

	/** 当前编辑行序号：-1 全收起，点击行切换 */
	const editing = ref(-1);

	function toggle(i: number): void {
		editing.value = editing.value === i ? -1 : i;
	}

	function removeItem(i: number): void {
		props.links.splice(i, 1);
		if (editing.value === i) editing.value = -1;
	}

	function move(i: number, delta: number): void {
		const j = i + delta;
		if (j < 0 || j >= props.links.length) return;
		[props.links[i], props.links[j]] = [props.links[j], props.links[i]];
	}

	/* ---------- 拖拽排序：模块级上下文，跨实例（跨分组）移动 ---------- */
	interface NavDragCtx {
		list: NavBarLink[];
		index: number;
	}
	let dragCtx: NavDragCtx | null = null;

	const rootEl = ref<HTMLElement | null>(null);
	const dragOver = ref(false);

	function onDragStart(i: number, e: DragEvent): void {
		dragCtx = { list: props.links, index: i };
		if (e.dataTransfer) {
			e.dataTransfer.effectAllowed = "move";
			e.dataTransfer.setData("text/plain", String(i));
		}
	}

	function resetDrag(): void {
		dragCtx = null;
		dragOver.value = false;
	}

	function onDragOver(e: DragEvent): void {
		if (!dragCtx || !e.dataTransfer) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = "move";
		dragOver.value = true;
	}

	function onDragLeave(e: DragEvent): void {
		if (!rootEl.value?.contains(e.relatedTarget as Node | null)) dragOver.value = false;
	}

	/** 落点插入序号：首个中点在指针下方的直接子节点之前，否则追加末尾 */
	function insertionIndex(e: DragEvent): number {
		const items = rootEl.value?.querySelectorAll<HTMLElement>(":scope > .nav-node") ?? [];
		for (let i = 0; i < items.length; i += 1) {
			const r = items[i].getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) return i;
		}
		return items.length;
	}

	function onDrop(e: DragEvent): void {
		const ctx = dragCtx;
		if (!ctx) return;
		e.preventDefault();
		const item = ctx.list[ctx.index];
		const to = insertionIndex(e);
		resetDrag();
		editing.value = -1;
		if (!item) return;
		// 嵌套层拒收分组（分组不可再套分组）
		if (ctx.list !== props.links) {
			if (!props.allowGroup && kindOf(item) === "group") return;
			ctx.list.splice(ctx.index, 1);
			props.links.splice(to, 0, item);
		} else {
			const [moved] = props.links.splice(ctx.index, 1);
			props.links.splice(ctx.index < to ? to - 1 : to, 0, moved);
		}
	}
</script>

<template>
	<div
		ref="rootEl"
		class="nav-list"
		:class="{ 'nav-list--over': dragOver }"
		@dragover="onDragOver"
		@dragleave="onDragLeave"
		@drop="onDrop"
	>
		<div
			v-for="(item, i) in links"
			:key="i"
			class="nav-node"
			:class="{ 'nav-node--editing': editing === i }"
		>
			<div
				class="nav-row"
				draggable="true"
				@dragstart="onDragStart(i, $event)"
				@dragend="resetDrag"
				@click="toggle(i)"
			>
				<el-icon class="nav-row__caret" :class="{ 'is-open': editing === i }"><CaretRight /></el-icon>
				<el-icon class="nav-row__grip"><Rank /></el-icon>
				<DataIcon :icon="iconOf(item)" :label="titleOf(item)" :size="24" class="nav-row__icon" />
				<span
					class="nav-row__name"
					:class="{ 'is-unknown': kindOf(item) === 'preset' && !navPresetOf(item.preset) }"
				>
					{{ titleOf(item) }}
				</span>
				<span v-if="kindOf(item) === 'group'" class="nav-row__count muted">{{ item.children?.length ?? 0 }} 项</span>
				<el-tag class="nav-row__kind" size="small" effect="plain" :type="KIND_META[kindOf(item)].tag">
					{{ KIND_META[kindOf(item)].label }}
				</el-tag>
				<span class="nav-row__ops">
					<el-button size="small" circle text :disabled="i === 0" @click.stop="move(i, -1)">
						<el-icon><ArrowUp /></el-icon>
					</el-button>
					<el-button size="small" circle text :disabled="i === links.length - 1" @click.stop="move(i, 1)">
						<el-icon><ArrowDown /></el-icon>
					</el-button>
					<el-button size="small" circle text type="danger" @click.stop="removeItem(i)">
						<el-icon><Close /></el-icon>
					</el-button>
				</span>
			</div>

			<!-- 分组收起时：只读子树 -->
			<div v-if="kindOf(item) === 'group' && editing !== i" class="nav-subtree">
				<div
					v-for="(child, j) in item.children"
					:key="j"
					class="nav-row nav-row--child"
					@click="toggle(i)"
				>
					<DataIcon :icon="iconOf(child)" :label="titleOf(child)" :size="20" class="nav-row__icon" />
					<span class="nav-row__name">{{ titleOf(child) }}</span>
				</div>
			</div>

			<!-- 编辑区：点击行展开 -->
			<div v-if="editing === i" class="nav-edit">
				<template v-if="kindOf(item) === 'preset'">
					<label class="nav-field">
						<span class="nav-field__label">页面预设</span>
						<el-select v-model="item.preset" filterable allow-create default-first-option placeholder="选择内置页面">
							<el-option v-for="p in NAV_PRESETS" :key="p.value" :value="p.value" :label="p.label">
								<div class="nav-preset-opt">
									<DataIcon :icon="p.icon" :size="22" />
									<span class="nav-preset-opt__label">{{ p.label }}</span>
									<span class="nav-preset-opt__desc">{{ p.desc }}</span>
								</div>
							</el-option>
						</el-select>
					</label>
					<p v-if="item.preset && !navPresetOf(item.preset)" class="nav-field__warn">未知预设，保存后构建会失败</p>
				</template>

				<template v-else-if="kindOf(item) === 'link'">
					<div class="nav-edit__grid">
						<label class="nav-field">
							<span class="nav-field__label">名称</span>
							<el-input v-model="item.name" placeholder="导航栏显示的文字" />
						</label>
						<label class="nav-field">
							<span class="nav-field__label">图标</span>
							<IconInput
								:model-value="item.icon ?? ''"
								:label="item.name ?? ''"
								@update:model-value="(v: string) => (item.icon = v)"
							/>
						</label>
						<label class="nav-field nav-field--full">
							<span class="nav-field__label">链接地址</span>
							<el-input v-model="item.url" placeholder="https://… 或 /path/" />
						</label>
					</div>
					<el-checkbox v-model="item.external" class="nav-field__check">外部链接（新标签页打开）</el-checkbox>
				</template>

				<template v-else>
					<div class="nav-edit__grid">
						<label class="nav-field">
							<span class="nav-field__label">分组名称</span>
							<el-input v-model="item.name" placeholder="如：更多" />
						</label>
						<label class="nav-field">
							<span class="nav-field__label">图标</span>
							<IconInput
								:model-value="item.icon ?? ''"
								:label="item.name ?? ''"
								@update:model-value="(v: string) => (item.icon = v)"
							/>
						</label>
					</div>
					<div class="nav-sub">
						<NavBarLinksEditor v-if="item.children" :links="item.children" :allow-group="false" />
						<div class="nav-sub__ops">
							<el-button size="small" plain @click="item.children?.push({ preset: '' })">
								<el-icon><Plus /></el-icon>内置页面
							</el-button>
							<el-button
								size="small"
								plain
								@click="item.children?.push({ name: '', icon: '', url: '', external: false })"
							>
								<el-icon><Plus /></el-icon>自定义链接
							</el-button>
						</div>
					</div>
				</template>

				<div class="nav-edit__done">
					<el-button size="small" @click="editing = -1">收起</el-button>
				</div>
			</div>
		</div>

		<div v-if="!links.length" class="nav-list__empty muted">暂无菜单项</div>
	</div>
</template>

<style scoped>
	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		border-radius: 12px;
		transition: background 0.15s;
	}
	.nav-list--over {
		background: rgba(103, 80, 164, 0.06);
	}
	.nav-list__empty {
		padding: 18px 0;
		text-align: center;
		font-size: 20px;
		border: 1px dashed var(--el-border-color);
		border-radius: 10px;
	}
	.nav-node {
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 10px;
		background: rgba(255, 255, 255, 0.5);
		overflow: hidden;
	}
	.nav-node--editing {
		border-color: var(--el-color-primary);
	}
	.nav-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		cursor: pointer;
		user-select: none;
	}
	.nav-row:hover {
		background: rgba(128, 128, 150, 0.07);
	}
	.nav-row__grip {
		color: var(--el-text-color-secondary);
		flex: none;
		cursor: grab;
	}
	.nav-row__icon {
		flex: none;
	}
	.nav-row__name {
		font-size: 20px;
		font-weight: 600;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.nav-row__name.is-unknown {
		color: var(--el-color-danger);
	}
	.nav-row__count {
		flex: none;
		font-size: 20px;
	}
	.nav-row__kind {
		flex: none;
	}
	.nav-row__caret {
		flex: none;
		color: var(--el-text-color-secondary);
		transition: transform 0.2s;
	}
	.nav-row__caret.is-open {
		transform: rotate(90deg);
	}
	.nav-row__ops {
		margin-left: auto;
		display: inline-flex;
		align-items: center;
		flex: none;
		opacity: 0;
		transition: opacity 0.15s;
	}
	.nav-row:hover .nav-row__ops,
	.nav-node--editing .nav-row__ops {
		opacity: 1;
	}
	.nav-row__ops .el-button + .el-button {
		margin-left: 2px;
	}
	.nav-subtree {
		display: flex;
		flex-direction: column;
		border-top: 1px dashed var(--el-border-color-lighter);
	}
	.nav-row--child {
		padding: 5px 12px 5px 40px;
	}
	.nav-row--child .nav-row__name {
		font-weight: 400;
		color: var(--el-text-color-regular);
	}
	.nav-edit {
		border-top: 1px dashed var(--el-border-color-lighter);
		padding: 12px;
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
	.nav-field--full {
		grid-column: 1 / -1;
	}
	.nav-field__label {
		font-size: 20px;
		color: var(--el-text-color-secondary);
		line-height: 1;
	}
	.nav-field__check {
		font-size: 20px;
	}
	.nav-field__warn {
		margin: 0;
		font-size: 20px;
		color: var(--el-color-danger);
	}
	.nav-edit__done {
		display: flex;
		justify-content: flex-end;
	}
	.nav-sub {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 10px;
		border: 1px dashed var(--el-border-color);
		border-radius: 10px;
	}
	.nav-sub__ops {
		display: flex;
		gap: 8px;
	}
	/* 预设富选项：下拉虽 teleport 到 body，插槽节点仍带 scope 属性，scoped 样式可生效 */
	.nav-preset-opt {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.nav-preset-opt__label {
		flex: none;
	}
	.nav-preset-opt__desc {
		margin-left: auto;
		color: var(--el-text-color-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
</style>
