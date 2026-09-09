<script setup lang="ts">
	/**
	 * 数据图标四态渲染（与主题 CompassTile 同一套判定，保证预览即所得）：
	 * 1. image（自定义图片 URL）→ img；
	 * 2. icon 为 Iconify 名（`material-symbols:xxx`）且命中内置离线集合 → @iconify/vue 本地渲染；
	 * 3. icon 为图片 URL/路径 → img（onerror 降级首字母块）；
	 * 4. 缺省或未收录的 Iconify 名 → label 首字母块（fallback="none" 时不渲染，如条目标签内）。
	 * 本工具不访问任何在线图标服务，未收录名不回退 api.iconify.design。
	 */
	import { computed, ref, watch } from "vue";
	import { Icon } from "@iconify/vue";
	import { contentPreviewUrl } from "../utils/assets";
	import { hasLocalIcon } from "../utils/icons";

	const props = withDefaults(
		defineProps<{
			icon?: string | null;
			image?: string | null;
			/** 首字母兜底用的文本（条目名称 / 书架名） */
			label?: string | null;
			/** 渲染尺寸 px（正方形图标位） */
			size?: number;
			/** 缺省兜底：letter 首字母块 / none 不渲染 */
			fallback?: "letter" | "none";
		}>(),
		{ icon: null, image: null, label: null, size: 20, fallback: "letter" },
	);

	const iconStr = computed(() => (typeof props.icon === "string" ? props.icon.trim() : ""));
	const imageStr = computed(() => (typeof props.image === "string" ? props.image.trim() : ""));

	const kind = computed<"image" | "iconify" | "letter">(() => {
		if (imageStr.value) return "image";
		if (/^[\w-]+:[\w-]+$/.test(iconStr.value) && hasLocalIcon(iconStr.value)) return "iconify";
		if (/^https?:\/\//.test(iconStr.value) || iconStr.value.startsWith("/")) return "image";
		return "letter";
	});

	const imgSrc = computed(() => contentPreviewUrl(imageStr.value || iconStr.value));
	const imgFailed = ref(false);
	// 图标源变化时重置失败态（条目排序后组件实例会被复用）
	watch(imgSrc, () => {
		imgFailed.value = false;
	});
	const letter = computed(() => (props.label ?? "?").toString().trim().charAt(0).toUpperCase() || "?");

	const boxStyle = computed(() => ({ width: `${props.size}px`, height: `${props.size}px` }));
	const letterStyle = computed(() => ({ fontSize: `${Math.round(props.size * 0.5)}px` }));
</script>

<template>
	<span v-if="kind !== 'letter' || fallback === 'letter'" class="data-icon" :style="boxStyle">
		<img
			v-if="kind === 'image' && imgSrc && !imgFailed"
			:src="imgSrc"
			alt=""
			loading="lazy"
			@error="imgFailed = true"
		/>
		<Icon v-else-if="kind === 'iconify'" :icon="iconStr" />
		<span v-else class="data-icon__letter" :style="letterStyle">{{ letter }}</span>
	</span>
</template>

<style scoped>
	.data-icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		border-radius: 6px;
		overflow: hidden;
		color: var(--el-color-primary);
	}
	.data-icon > :global(svg) {
		width: 100%;
		height: 100%;
	}
	.data-icon > img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.data-icon__letter {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 100%;
		border-radius: 6px;
		background: rgba(128, 128, 150, 0.14);
		color: var(--el-text-color-secondary);
		font-weight: 600;
		line-height: 1;
	}
</style>
