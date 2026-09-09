<script setup lang="ts">
	/**
	 * 条目列表可视化编辑器（罗盘导航条目 / 时间线关联链接共用）：
	 * 卡片式子表单替代手写 JSON，子字段由 fields 配置驱动（text / icon 带预览），
	 * 支持新增/删除/上下移动；字段值直接改写条目对象（父级持有同一引用），
	 * 结构变化整体 emit 新数组。占列由 span 控制（1 半行 / 2 整行）。
	 */
	import IconInput from "./IconInput.vue";
	import type { EntryDraft, EntrySubField } from "../descriptors/dataFields";

	const props = defineProps<{ modelValue: EntryDraft[]; fields: EntrySubField[] }>();
	const emit = defineEmits<{ "update:modelValue": [value: EntryDraft[]] }>();

	function addEntry(): void {
		const entry: EntryDraft = {};
		for (const s of props.fields) entry[s.key] = "";
		emit("update:modelValue", [...props.modelValue, entry]);
	}

	function removeEntry(index: number): void {
		emit(
			"update:modelValue",
			props.modelValue.filter((_, j) => j !== index),
		);
	}

	function moveEntry(index: number, delta: number): void {
		const j = index + delta;
		if (j < 0 || j >= props.modelValue.length) return;
		const arr = [...props.modelValue];
		[arr[index], arr[j]] = [arr[j], arr[index]];
		emit("update:modelValue", arr);
	}
</script>

<template>
	<div class="entries-editor">
		<div class="entries-editor__toolbar">
			<span class="muted">共 {{ modelValue.length }} 条</span>
			<el-button size="small" type="primary" plain @click="addEntry">
				<el-icon><Plus /></el-icon>新增条目
			</el-button>
		</div>

		<div v-if="modelValue.length === 0" class="entries-editor__empty muted">
			暂无条目，点「新增条目」添加
		</div>

		<div v-for="(entry, i) in modelValue" :key="i" class="entry-card">
			<div class="entry-card__head">
				<span class="entry-card__no">#{{ i + 1 }}</span>
				<span class="entry-card__ops">
					<el-button size="small" text :disabled="i === 0" @click="moveEntry(i, -1)">
						<el-icon><ArrowUp /></el-icon>
					</el-button>
					<el-button
						size="small"
						text
						:disabled="i === modelValue.length - 1"
						@click="moveEntry(i, 1)"
					>
						<el-icon><ArrowDown /></el-icon>
					</el-button>
					<el-button size="small" text type="danger" @click="removeEntry(i)">
						<el-icon><Delete /></el-icon>
					</el-button>
				</span>
			</div>
			<div class="entry-card__grid">
				<label
					v-for="s in fields"
					:key="s.key"
					class="entry-field"
					:style="s.span === 2 ? { gridColumn: 'span 2' } : undefined"
				>
					<span class="entry-field__label">{{ s.label }} <i v-if="s.required" class="req">*</i></span>
					<el-input
						v-if="s.type === 'text'"
						:model-value="String(entry[s.key] ?? '')"
						:placeholder="s.placeholder"
						@update:model-value="(v: string) => (entry[s.key] = v)"
					/>
					<IconInput
						v-else
						:model-value="String(entry[s.key] ?? '')"
						:label="String(entry.label ?? '')"
						:placeholder="s.placeholder"
						@update:model-value="(v: string) => (entry[s.key] = v)"
					/>
				</label>
			</div>
		</div>
	</div>
</template>

<style scoped>
	.entries-editor {
		width: 100%;
	}
	.entries-editor__toolbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
		font-size: 20px;
	}
	.entries-editor__empty {
		padding: 18px 0;
		text-align: center;
		font-size: 20px;
		border: 1px dashed var(--el-border-color);
		border-radius: 8px;
	}
	.entry-card {
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		padding: 8px 12px 12px;
		margin-bottom: 8px;
	}
	.entry-card__head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 8px;
	}
	.entry-card__no {
		font-size: 20px;
		color: var(--el-text-color-secondary);
		font-weight: 600;
	}
	.entry-card__ops {
		display: inline-flex;
		align-items: center;
	}
	.entry-card__ops .el-button + .el-button {
		margin-left: 4px;
	}
	.entry-card__grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px 12px;
	}
	.entry-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}
	.entry-field__label {
		font-size: 20px;
		color: var(--el-text-color-secondary);
		line-height: 1;
	}
	.req {
		color: var(--el-color-danger);
		font-style: normal;
	}
</style>
