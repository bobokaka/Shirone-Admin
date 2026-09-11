<script setup lang="ts">
	/**
	 * 图标字段输入：字段点击开「图标库」弹窗（内置离线集合，按集合前缀与名称关键字筛选点选），
	 * 弹窗底部保留库外值手输兜底（图片路径等无法从库中选出的值）。
	 * 值仍为 Iconify 名（material-symbols:web）或图片路径（/images/…）。
	 */
	import { computed, ref, watch } from "vue";
	import DataIcon from "./DataIcon.vue";
	import { BUNDLED_COLLECTIONS, BUNDLED_ICON_PREFIXES } from "../utils/icons";

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

	watch(visible, (v) => {
		if (!v) return;
		draft.value = props.modelValue;
		query.value = "";
		scope.value = "all";
	});

	/** 名字归一化比较（忽略连字符 / 下划线 / 大小写） */
	function norm(s: string): string {
		return s.toLowerCase().replace(/[\s_-]/g, "");
	}

	const MAX_SHOWN = 240;

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
	const shown = computed(() => matches.value.slice(0, MAX_SHOWN));
	const truncated = computed(() => matches.value.length > shown.value.length);

	const scopeOptions = [
		{ label: "全部", value: "all" },
		...BUNDLED_COLLECTIONS.map((c) => ({ label: c.prefix, value: c.prefix })),
	];

	function confirmPick(): void {
		emit("update:modelValue", draft.value.trim());
		visible.value = false;
	}
</script>

<template>
	<div class="icon-input" @click="visible = true">
		<span class="icon-input__preview">
			<DataIcon :icon="modelValue" :label="label" :size="22" />
		</span>
		<span class="icon-input__value" :title="modelValue">
			{{ modelValue || placeholder || `点击选择（${BUNDLED_ICON_PREFIXES.join(" / ")}）` }}
		</span>
		<el-button
			v-if="modelValue"
			size="small"
			circle
			text
			type="danger"
			title="清除图标"
			@click.stop="emit('update:modelValue', '')"
		>
			<el-icon><CircleClose /></el-icon>
		</el-button>
		<el-icon class="icon-input__arrow"><Grid /></el-icon>
	</div>

	<el-dialog v-model="visible" title="选择图标" width="680px" append-to-body>
		<div class="picker-head">
			<el-input v-model="query" placeholder="按名称筛选（如 home / github）" clearable>
				<template #prefix><el-icon><Search /></el-icon></template>
			</el-input>
			<el-segmented v-model="scope" :options="scopeOptions" />
		</div>
		<div class="picker-grid">
			<button
				v-for="name in shown"
				:key="name"
				type="button"
				class="picker-tile"
				:class="{ 'picker-tile--on': name === draft }"
				:title="name"
				@click="draft = name"
				@dblclick="confirmPick()"
			>
				<DataIcon :icon="name" :size="24" fallback="none" />
			</button>
			<div v-if="!shown.length" class="picker-empty muted">无匹配图标</div>
		</div>
		<p class="picker-hint muted">
			{{
				truncated
					? `共 ${matches.length} 个匹配，仅显示前 ${MAX_SHOWN} 个，输入关键字缩小范围`
					: `共 ${matches.length} 个`
			}}
		</p>
		<div class="picker-manual">
			<span class="picker-manual__label">库外值</span>
			<el-input v-model="draft" placeholder="图片路径（/images/…）或完整图标名" clearable />
		</div>
		<template #footer>
			<div class="picker-foot">
				<span class="picker-picked">
					<DataIcon :icon="draft" :label="label" :size="20" />
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
		gap: 8px;
		width: 100%;
		min-height: 40px;
		padding: 2px 8px;
		border: 1px solid var(--el-border-color);
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.6);
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.icon-input:hover {
		border-color: var(--el-color-primary);
	}
	.icon-input__preview {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 6px;
		background: rgba(128, 128, 150, 0.1);
	}
	.icon-input__value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: calc(20px + var(--font-shift, 0px));
		color: var(--el-text-color-regular);
	}
	.icon-input__arrow {
		flex: none;
		color: var(--el-text-color-secondary);
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
		grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
		gap: 6px;
		max-height: 46vh;
		overflow-y: auto;
		padding: 8px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 10px;
	}
	.picker-tile {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 48px;
		padding: 0;
		border: 1px solid transparent;
		border-radius: 8px;
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
	.picker-hint {
		margin: 8px 0 0;
		font-size: 18px;
	}
	.picker-manual {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 10px;
	}
	.picker-manual__label {
		flex: none;
		font-size: 18px;
		color: var(--el-text-color-secondary);
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
		font-size: 18px;
		color: var(--el-text-color-regular);
	}
	.grow {
		flex: 1;
	}
</style>
