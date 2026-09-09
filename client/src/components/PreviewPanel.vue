<script setup lang="ts">
	import { computed, onMounted, onUnmounted, ref } from "vue";
	import { ElMessage } from "element-plus";
	import { systemApi } from "../api";

	const props = withDefaults(
		defineProps<{
			/** 挂载即点火（未就绪时）；false 则只探测，手动启动 */
			autostart?: boolean;
			/** iframe 区域高度 */
			frameHeight?: string;
			/** 提供时工具行升级为卡片头：标题与控件同排，省一行高度 */
			title?: string;
		}>(),
		{ autostart: false, frameHeight: "calc(80vh - 130px)" },
	);

	const st = ref<{ running: boolean; ready: boolean; procs: string[] }>({
		running: false,
		ready: false,
		procs: [],
	});
	const busy = ref(false);
	let timer: ReturnType<typeof setInterval> | null = null;

	const statusType = computed<"success" | "warning" | "info">(() =>
		st.value.ready ? "success" : st.value.running ? "warning" : "info",
	);
	const statusText = computed(() => {
		if (st.value.ready) {
			return st.value.running ? "站点就绪 :4321" : "检测到 dev server 已在运行 :4321";
		}
		return st.value.running ? "启动中，首次需编译…" : "未运行";
	});

	async function poll(): Promise<void> {
		try {
			st.value = await systemApi.previewStatus();
		} catch {
			st.value = { running: false, ready: false, procs: [] };
		}
	}

	async function start(): Promise<void> {
		if (st.value.ready) return;
		busy.value = true;
		try {
			const r = await systemApi.previewStart();
			ElMessage.success(r.message);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			busy.value = false;
		}
	}

	async function stop(): Promise<void> {
		busy.value = true;
		try {
			await systemApi.previewStop();
			ElMessage.info("预览已停止");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			busy.value = false;
		}
	}

	function openSite(): void {
		window.open("http://localhost:4321/", "_blank");
	}

	onMounted(async () => {
		await poll();
		if (props.autostart && !st.value.ready) void start();
		timer = setInterval(poll, 3000);
	});

	onUnmounted(() => {
		if (timer) clearInterval(timer);
	});
</script>

<template>
	<div class="panel" :class="{ 'with-title': title }">
		<div class="bar" :class="{ 'with-title': title }">
			<span v-if="title" class="bar-title">{{ title }}</span>
			<el-button
				v-if="!st.ready && !st.running"
				type="success"
				size="small"
				:loading="busy"
				@click="start"
			>
				启动
			</el-button>
			<el-button v-if="st.running" type="warning" size="small" :loading="busy" @click="stop">
				停止
			</el-button>
			<el-tag :type="statusType" size="small">{{ statusText }}</el-tag>
			<div class="grow"></div>
			<el-button size="small" @click="openSite">新窗口打开</el-button>
		</div>
		<div class="panel-body" :class="{ padded: title }">
			<el-alert
				v-if="st.running && !st.ready"
				type="warning"
				:closable="false"
				title="正在启动真站预览，首次启动可能需要 20-60 秒"
				style="margin-bottom: 10px"
			/>
			<div v-if="st.ready" class="frame-wrap" :style="{ height: frameHeight }">
				<iframe src="http://localhost:4321/" class="frame"></iframe>
			</div>
			<el-empty v-else description="未检测到 dev server，启动后在这里预览真站渲染效果" />
		</div>
	</div>
</template>

<style scoped>
	.bar {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 10px;
	}

	/* 带 title 时整行充当卡片头：标题 + 控件同排，下方以发丝线分隔 */
	.bar.with-title {
		padding: 12px 20px;
		margin-bottom: 0;
		border-bottom: 1px solid var(--hairline);
	}

	.bar-title {
		font-weight: 600;
		margin-right: 2px;
	}

	.grow {
		flex: 1;
	}

	.panel-body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}

	.panel-body.padded {
		padding: 12px 20px 20px;
	}

	.frame-wrap {
		min-height: 320px;
		border: 1px solid var(--glass-border-soft);
		border-radius: 10px;
		overflow: hidden;
	}

	.frame {
		width: 100%;
		height: 100%;
		border: none;
	}
</style>
