<script setup lang="ts">
	import { computed, ref, watch } from "vue";
	import type { DirCandidate, DirDetectResult } from "@shirone-admin/shared";
	import { systemApi } from "../api";

	/**
	 * AI 查找仓库目录：打开即扫描（特征文件 + AI 裁决），
	 * 单选候选后「应用所选」回填表单输入框——不直接保存，保存仍走各节保存按钮。
	 */
	const visible = defineModel<boolean>({ default: false });
	const props = defineProps<{
		/** 查找目标：content = 内容仓，theme = 主题仓 */
		target: "content" | "theme";
	}>();
	const emit = defineEmits<{ applied: [path: string] }>();

	const dialogTitle = computed(() => `AI 查找${props.target === "content" ? "内容仓" : "主题仓"}目录`);
	const detecting = ref(false);
	const result = ref<DirDetectResult | null>(null);
	const selected = ref("");

	const candidates = computed<DirCandidate[]>(() =>
		props.target === "content" ? (result.value?.contentCandidates ?? []) : (result.value?.themeCandidates ?? []),
	);

	async function detect(): Promise<void> {
		if (detecting.value) return;
		detecting.value = true;
		result.value = null;
		selected.value = "";
		try {
			result.value = await systemApi.detectDirs();
			if (candidates.value.length > 0) selected.value = candidates.value[0].path;
		} finally {
			detecting.value = false;
		}
	}

	function apply(): void {
		if (!selected.value) return;
		emit("applied", selected.value);
		visible.value = false;
	}

	watch(visible, (v) => {
		if (v) {
			void detect();
			return;
		}
		result.value = null;
		selected.value = "";
	});
</script>

<template>
	<el-dialog
		v-model="visible"
		:title="dialogTitle"
		width="720px"
		align-center
		append-to-body
		:close-on-click-modal="false"
		class="dir-detect-dialog"
	>
		<div v-loading="detecting" class="detect-body">
			<div v-if="result && !result.aiUsed" class="detect-note">
				AI 未参与{{ result.aiError ? `（${result.aiError}）` : "（未配置）" }}，以下为特征扫描结果
			</div>
			<el-radio-group v-if="candidates.length > 0" v-model="selected" class="detect-list">
				<label v-for="c in candidates" :key="c.path" class="detect-item">
					<el-radio :value="c.path" size="large">
						<span class="detect-path" :title="c.path">{{ c.path }}</span>
					</el-radio>
					<div class="detect-meta">
						<el-tag size="small" :type="c.source === 'ai' ? 'primary' : 'info'" effect="plain" disable-transitions>
							{{ c.source === "ai" ? "AI" : "扫描" }}
						</el-tag>
						<span class="detect-conf">{{ Math.round(c.confidence * 100) }}%</span>
						<span class="detect-reason">{{ c.reason }}</span>
					</div>
				</label>
			</el-radio-group>
			<el-empty
				v-else-if="!detecting"
				description="未找到候选，请手动输入路径"
				:image-size="72"
			/>
		</div>
		<template #footer>
			<el-button plain :loading="detecting" @click="detect()">重新扫描</el-button>
			<el-button type="primary" :disabled="!selected" @click="apply()">应用所选</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
	.detect-body {
		min-height: 160px;
	}
	.detect-note {
		color: var(--el-text-color-secondary);
		font-size: 20px;
		margin-bottom: 10px;
	}
	.detect-list {
		display: flex;
		flex-direction: column;
		gap: 8px;
		width: 100%;
	}
	.detect-item {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--glass-border-soft);
		border-radius: 10px;
		padding: 8px 14px;
		cursor: pointer;
	}
	.detect-item:has(.el-radio__input.is-checked) {
		border-color: var(--el-color-primary);
	}
	.detect-path {
		font-family: var(--el-font-family-mono, monospace);
		word-break: break-all;
	}
	.detect-meta {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 2px 0 0 24px;
		color: var(--el-text-color-secondary);
		font-size: 20px;
		min-width: 0;
	}
	.detect-conf {
		color: var(--el-text-color-regular);
	}
	.detect-reason {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
