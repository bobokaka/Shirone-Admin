<script setup lang="ts">
	import { onBeforeUnmount, onMounted, ref, watch } from "vue";
	import { basicSetup } from "codemirror";
	import { EditorState, type Extension } from "@codemirror/state";
	import { EditorView, placeholder as cmPlaceholder, type ViewUpdate } from "@codemirror/view";
	import { html } from "@codemirror/lang-html";

	/** HTML 源码编辑器：语法高亮 / 行号 / 补全 / 括号匹配（basicSetup + lang-html），暴露光标处插入 */
	const props = withDefaults(defineProps<{ modelValue: string; height?: string; placeholder?: string }>(), {
		height: "320px",
		placeholder: "",
	});
	const emit = defineEmits<{ (e: "update:modelValue", v: string): void }>();

	const host = ref<HTMLElement | null>(null);
	let view: EditorView | null = null;

	const extensions: Extension[] = [
		basicSetup,
		html(),
		EditorView.lineWrapping,
		cmPlaceholder(props.placeholder),
		EditorView.updateListener.of((v: ViewUpdate) => {
			if (v.docChanged) emit("update:modelValue", v.state.doc.toString());
		}),
	];

	onMounted(() => {
		if (!host.value) return;
		view = new EditorView({ parent: host.value, state: EditorState.create({ doc: props.modelValue, extensions }) });
	});

	/* 外部值变化（格式化/替换图片等）整文替换，用户编辑引起的不动 */
	watch(
		() => props.modelValue,
		(next) => {
			if (!view || next === view.state.doc.toString()) return;
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
		},
	);

	onBeforeUnmount(() => view?.destroy());

	/** 在光标处插入片段（选中内容被替换），插完聚焦 */
	function insertAtCursor(text: string): void {
		if (!view) return;
		const r = view.state.selection.main;
		view.dispatch({
			changes: { from: r.from, to: r.to, insert: text },
			selection: { anchor: r.from + text.length },
			scrollIntoView: true,
		});
		view.focus();
	}

	defineExpose({ insertAtCursor });
</script>

<template>
	<div ref="host" class="html-editor" :style="{ height }"></div>
</template>

<style scoped>
	.html-editor {
		border: 1px solid var(--glass-border-soft);
		border-radius: 12px;
		overflow: hidden;
		background: rgba(255, 255, 255, 0.62);
	}
	.html-editor :deep(.cm-editor) {
		height: 100%;
		font-size: 20px;
	}
	.html-editor :deep(.cm-editor.cm-focused) {
		outline: none;
	}
	.html-editor :deep(.cm-scroller) {
		font-family: Consolas, "Courier New", monospace;
		line-height: 1.6;
	}
	/* 行号是纯辅助微件，允许小字号 */
	.html-editor :deep(.cm-gutters) {
		font-size: 16px;
	}
</style>
