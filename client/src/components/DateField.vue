<script setup lang="ts">
	/**
	 * 日期字符串字段：日精度选择器，存储值为点分日格式 YYYY.MM.DD（与站点风格一致）。
	 * 历史遗留的月份等自由文本不在选择器回显，但保存时原样保留，重选或清空才覆盖。
	 */
	defineProps<{ modelValue: string }>();
	const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
	<el-date-picker
		:model-value="/^\d{4}\.\d{2}\.\d{2}$/.test(modelValue) ? modelValue : ''"
		type="date"
		format="YYYY.MM.DD"
		value-format="YYYY.MM.DD"
		placeholder="精确到日"
		clearable
		class="date-field__picker"
		@update:model-value="(v: string | null) => emit('update:modelValue', v ?? '')"
	/>
</template>

<style scoped>
	.date-field__picker {
		width: 200px;
	}
</style>
