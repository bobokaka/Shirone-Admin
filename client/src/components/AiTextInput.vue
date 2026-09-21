<script setup lang="ts">
	import { computed, ref } from "vue";
	import { Icon } from "@iconify/vue";
	import { useAiConsoleStore } from "../stores/aiConsole";

	/**
	 * 文本输入 + AI 按钮：流式回填（结果直接在输入框里长出来，可停止），有值改写、无值按 context 生成，一句中文。
	 * 单行走 append 插槽；rows>0 走 textarea + 右下悬浮「AI」按钮（append 不支持 textarea）。
	 */
	const props = withDefaults(
		defineProps<{
			modelValue: string;
			/** 字段用途与上下文（拼进 AI 指令），如「站点副标题（站名：小白屋）」 */
			context: string;
			rows?: number;
			placeholder?: string;
			/** AI 是否启用：关闭时不渲染按钮，退回普通输入框 */
			ai?: boolean;
			disabled?: boolean;
		}>(),
		{ rows: 0, placeholder: "", ai: false, disabled: false },
	);
	const emit = defineEmits<{ "update:modelValue": [value: string] }>();

	const aiConsole = useAiConsoleStore();
	const running = computed(() => aiConsole.running);
	/** 本实例发起的任务进行中：按钮转为「停止」；别处任务运行时仍禁用 */
	const mine = ref(false);

	function onInput(v: string): void {
		emit("update:modelValue", v);
	}

	function stop(): void {
		aiConsole.stop();
	}

	async function run(): Promise<void> {
		if (running.value || props.disabled) return;
		mine.value = true;
		try {
			const current = props.modelValue.trim();
			const instruction =
				current === ""
					? `为博客的「${props.context}」写一句简体中文文案，只输出内容本身，不要引号。`
					: `改写以下「${props.context}」，信息不变、表达更精炼自然，一句中文，只输出结果。`;
			// 流式回填：结果直接在输入框里长出来；停止/失败恢复原文
			const result = await aiConsole.run(
				{
					instruction,
					text: current === "" ? props.context : current,
					maxTokens: 2048,
				},
				{ onText: (full) => emit("update:modelValue", full) },
			);
			if (result === null) {
				emit("update:modelValue", current);
				aiConsole.reportOutcome();
			}
		} finally {
			mine.value = false;
		}
	}
</script>

<template>
	<div v-if="rows > 0" class="ai-textarea-field">
		<el-input
			:model-value="modelValue"
			type="textarea"
			:rows="rows"
			:placeholder="placeholder"
			:disabled="disabled"
			@update:model-value="onInput"
		/>
		<el-tooltip v-if="ai" content="AI 生成 / 改写（流式）" placement="top">
			<el-button
				v-if="mine && running"
				class="ai-field-btn"
				size="small"
				type="danger"
				plain
				@click="stop"
			>
				停止
			</el-button>
			<el-button
				v-else
				class="ai-field-btn"
				size="small"
				:disabled="running || disabled"
				@click="run"
			>
				<el-icon><Icon icon="material-symbols:autoawesome" /></el-icon>AI
			</el-button>
		</el-tooltip>
	</div>
	<el-input
		v-else
		:model-value="modelValue"
		:placeholder="placeholder"
		:disabled="disabled"
		@update:model-value="onInput"
	>
		<template v-if="ai" #append>
			<el-tooltip content="AI 生成 / 改写（流式）" placement="top">
				<el-button v-if="mine && running" type="danger" plain @click="stop">停止</el-button>
				<el-button v-else :disabled="running || disabled" @click="run">
					<el-icon><Icon icon="material-symbols:autoawesome" /></el-icon>AI
				</el-button>
			</el-tooltip>
		</template>
	</el-input>
</template>

<style scoped>
	.ai-textarea-field {
		position: relative;
		width: 100%;
	}
	.ai-field-btn {
		position: absolute;
		right: 8px;
		bottom: 8px;
		z-index: 1;
	}
</style>
