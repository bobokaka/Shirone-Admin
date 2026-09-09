<script setup lang="ts">
	/**
	 * 图标字段输入：文本框 + 左侧实时预览（DataIcon 四态渲染）。
	 * 值可为 Iconify 名（material-symbols:web-rounded，仅限内置离线集合）或图片路径（/images/…）。
	 */
	import DataIcon from "./DataIcon.vue";
	import { BUNDLED_ICON_PREFIXES } from "../utils/icons";

	withDefaults(
		defineProps<{
			modelValue: string;
			placeholder?: string;
			/** 首字母兜底用的文本 */
			label?: string;
		}>(),
		{ placeholder: "", label: "" },
	);

	const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
	<div class="icon-input">
		<span class="icon-input__preview">
			<DataIcon :icon="modelValue" :label="label" :size="22" />
		</span>
		<el-input
			:model-value="modelValue"
			:placeholder="placeholder ?? `Iconify 名（内置 ${BUNDLED_ICON_PREFIXES.join(' / ')}）或图片路径`"
			clearable
			@update:model-value="(v: string) => emit('update:modelValue', v)"
		/>
	</div>
</template>

<style scoped>
	.icon-input {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
	}
	.icon-input__preview {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: none;
		width: 34px;
		height: 34px;
		border-radius: 8px;
		background: rgba(128, 128, 150, 0.1);
	}
</style>
