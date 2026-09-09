<script setup lang="ts">
	import { computed } from "vue";
	import { useRoute, useRouter } from "vue-router";
	import PostEditorPanel from "../components/PostEditorPanel.vue";

	/** 完整编辑页：PostEditorPanel 的分栏预览形态（文章管理页的就地编辑共用该组件） */
	const route = useRoute();
	const router = useRouter();
	const path = computed(() => String(route.query.path ?? ""));
	/** 从文章管理页「分栏编辑」进来：返回时恢复该篇的单栏编辑态，而非列表预览 */
	const fromInline = computed(() => String(route.query.from ?? "") === "inline");

	function goBack(): void {
		if (fromInline.value) router.push({ path: "/posts", query: { edit: path.value } });
		else router.push("/posts");
	}
</script>

<template>
	<div class="editor-page">
		<PostEditorPanel :path="path" @back="goBack" @removed="router.push('/posts')" />
	</div>
</template>

<style scoped>
	.editor-page {
		height: calc(100vh - 96px);
		min-height: 420px;
	}
</style>
