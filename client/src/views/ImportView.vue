<script setup lang="ts">
	import { computed, onUnmounted, ref } from "vue";
	import { useRouter } from "vue-router";
	import { ElMessage, ElMessageBox } from "element-plus";
	import type { UploadRequestOptions } from "element-plus";
	import { MdPreview } from "md-editor-v3";
	import type {
		JianshuArchiveSummary,
		JianshuImportJob,
		JianshuPreview,
	} from "@shirone-admin/shared";
	import { importApi } from "../api";
	import SingleImportWizard from "../components/SingleImportWizard.vue";
	import { localMediaSanitize } from "../utils/content-media";

	const router = useRouter();

	/** 导入 tab：本地导入在前；后续平台加 tab-pane 即可 */
	const activePlatform = ref("local");

	const today = (() => {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	})();

	/* ---------- 简书：null 选择方式 → archive 导出包向导（单篇粘贴在 SingleImportWizard 组件） ---------- */
	const mode = ref<null | "archive" | "paste">(null);
	const step = ref(0);
	/** 步骤条从「选择导入方式」开始全程显示；卡片页沿用上次选择的模式标签 */
	const ARCHIVE_STEPS = ["选择导入方式", "上传导出包", "选择文章", "内容转换", "导入完成"];
	const PASTE_STEPS = ["选择导入方式", "粘贴内容", "内容转换", "文章信息", "导入完成"];
	const lastMode = ref<"archive" | "paste">("archive");
	const steps = computed(() => (lastMode.value === "paste" ? PASTE_STEPS : ARCHIVE_STEPS));

	function chooseMode(m: "archive" | "paste"): void {
		mode.value = m;
		lastMode.value = m;
		step.value = 0;
	}

	/* ---------- 导出包：会话与文章清单 ---------- */
	const summary = ref<JianshuArchiveSummary | null>(null);
	const uploading = ref(false);
	const selectedIds = ref<string[]>([]);

	const importedSet = computed(() => {
		const s = new Set(summary.value?.importedIds ?? []);
		// 已完成任务的成功项并入：导入完成后列表立即标「已导入」并禁选，防重复导入
		if (job.value?.status === "done") {
			for (const r of job.value.results) if (r.ok) s.add(r.id);
		}
		return s;
	});
	const selectedCount = computed(() => selectedIds.value.length);
	/** 尚未导入（可勾选）的文章数 */
	const selectableCount = computed(() =>
		(summary.value?.notebooks ?? []).reduce(
			(n, nb) => n + nb.articles.filter((a) => !importedSet.value.has(a.id)).length,
			0,
		),
	);

	async function doUpload(opt: UploadRequestOptions): Promise<void> {
		if (uploading.value) return;
		uploading.value = true;
		try {
			summary.value = await importApi.uploadArchive(opt.file as File);
			// 默认全选未导入过的，解析成功即进入选择步
			selectedIds.value = (summary.value.notebooks ?? []).flatMap((n) =>
				n.articles.filter((a) => !importedSet.value.has(a.id)).map((a) => a.id),
			);
			step.value = 1;
			ElMessage.success(`解析成功：${summary.value.total} 篇文章`);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			uploading.value = false;
		}
	}

	function toggleGroup(name: string, checked: boolean): void {
		const group = summary.value?.notebooks.find((n) => n.name === name);
		if (!group) return;
		const ids = group.articles.map((a) => a.id);
		const rest = selectedIds.value.filter((id) => !ids.includes(id));
		selectedIds.value = checked ? [...rest, ...ids] : rest;
	}

	function groupChecked(name: string): boolean {
		const group = summary.value?.notebooks.find((n) => n.name === name);
		if (!group) return false;
		return group.articles.every((a) => selectedIds.value.includes(a.id));
	}

	function selectAll(): void {
		if (!summary.value) return;
		selectedIds.value = (summary.value.notebooks ?? []).flatMap((n) =>
			n.articles.filter((a) => !importedSet.value.has(a.id)).map((a) => a.id),
		);
	}

	function clearAll(): void {
		selectedIds.value = [];
	}

	async function dropSession(): Promise<void> {
		if (!summary.value) return;
		if (job.value?.status === "running") {
			ElMessage.warning("导入进行中，不能丢弃");
			return;
		}
		try {
			await ElMessageBox.confirm("丢弃当前导出包与会话？", "丢弃", { type: "warning" });
		} catch {
			return; // 用户取消
		}
		try {
			await importApi.deleteSession(summary.value.sessionId);
		} finally {
			summary.value = null;
			selectedIds.value = [];
			job.value = null;
			jobId.value = "";
			step.value = 0;
		}
	}

	/** 完成页：导入下一包 → 回到上传步 */
	function restart(): void {
		summary.value = null;
		selectedIds.value = [];
		job.value = null;
		jobId.value = "";
		step.value = 0;
	}

	function goPosts(): void {
		router.push("/posts");
	}

	/* ---------- 单篇预览（导出包流程） ---------- */
	const previewVisible = ref(false);
	const previewLoading = ref(false);
	const preview = ref<JianshuPreview | null>(null);

	async function openPreview(id: string): Promise<void> {
		if (!summary.value) return;
		previewVisible.value = true;
		previewLoading.value = true;
		preview.value = null;
		try {
			preview.value = await importApi.preview(summary.value.sessionId, id);
		} catch (e) {
			ElMessage.error((e as Error).message);
			previewVisible.value = false;
		} finally {
			previewLoading.value = false;
		}
	}

	/* ---------- 导出包：导入选项与任务 ---------- */
	const published = ref(today);
	const categoryFromNotebook = ref(true);
	const category = ref("");
	const tags = ref<string[]>([]);
	const localizeImages = ref(true);
	const draft = ref(true);
	const starting = ref(false);

	const job = ref<JianshuImportJob | null>(null);
	const jobId = ref("");
	let timer: ReturnType<typeof setInterval> | undefined;
	const running = computed(() => job.value?.status === "running");
	const doneCount = computed(() => job.value?.results.filter((r) => r.ok).length ?? 0);

	async function startImport(): Promise<void> {
		if (!summary.value || selectedCount.value === 0 || starting.value) return;
		starting.value = true;
		try {
			const r = await importApi.run({
				sessionId: summary.value.sessionId,
				ids: selectedIds.value,
				options: {
					published: published.value,
					categoryFromNotebook: categoryFromNotebook.value,
					category: categoryFromNotebook.value ? undefined : category.value || undefined,
					tags: tags.value,
					localizeImages: localizeImages.value,
					draft: draft.value,
				},
			});
			jobId.value = r.jobId;
			job.value = null;
			poll();
			timer = setInterval(poll, 2000);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			starting.value = false;
		}
	}

	async function poll(): Promise<void> {
		if (!jobId.value) return;
		try {
			job.value = await importApi.job(jobId.value);
			if (job.value.status === "done") {
				clearInterval(timer);
				timer = undefined;
				ElMessage.success(`导入完成：${doneCount.value}/${job.value.total} 篇`);
				if (step.value === 2) step.value = 3; // 完成页仅在任务结束后进入
			}
		} catch (e) {
			clearInterval(timer);
			timer = undefined;
			ElMessage.error((e as Error).message);
		}
	}

	onUnmounted(() => clearInterval(timer));

	function mediaSanitize(html: string): string {
		return localMediaSanitize(html);
	}
</script>

<template>
	<!-- 整页玻璃卡：tab 居中引导，每步一个主任务 -->
	<div class="import-view">
		<el-card class="page-card">
			<el-tabs v-model="activePlatform" class="platform-tabs">
				<!-- ===== 本地导入：选择本地 md 文件 → 图片本地化 → 信息填写 ===== -->
				<el-tab-pane label="本地导入" name="local" lazy>
					<div class="mode-scroll">
						<SingleImportWizard local />
					</div>
				</el-tab-pane>

				<!-- ===== 简书 ===== -->
				<el-tab-pane label="简书" name="jianshu" lazy>
					<div class="mode-scroll">
						<!-- 选择导入方式（垂直居中的选择卡；步骤条从这页开始显示） -->
						<div v-if="mode === null" class="wizard">
							<el-steps :active="0" align-center finish-status="success" class="steps">
								<el-step v-for="t in steps" :key="t" :title="t" />
							</el-steps>
							<div class="step-body">
								<div class="mode-cards">
									<button type="button" class="mode-card" @click="chooseMode('archive')">
										<span class="mode-icon"><el-icon :size="26"><Box /></el-icon></span>
										<span class="mode-title">导出包导入</span>
										<span class="mode-desc">简书「打包下载全部文章」，整批挑选导入</span>
									</button>
									<button type="button" class="mode-card" @click="chooseMode('paste')">
										<span class="mode-icon"><el-icon :size="26"><DocumentCopy /></el-icon></span>
										<span class="mode-title">单篇粘贴</span>
										<span class="mode-desc">网页版全选复制一篇文章，即贴即转</span>
									</button>
								</div>
							</div>
						</div>

						<!-- 单篇粘贴：独立向导组件（步骤条前置「选择导入方式」） -->
						<SingleImportWizard
							v-else-if="mode === 'paste'"
							prefix="选择导入方式"
							@exit="mode = null"
						/>

						<!-- 导出包向导（「选择导入方式」为已完成的首步） -->
						<div v-else class="wizard">
							<el-steps :active="step + 1" align-center finish-status="success" class="steps">
								<el-step v-for="t in steps" :key="t" :title="t" />
							</el-steps>

							<!-- ===== 第 1 步：上传导出包 ===== -->
							<div v-if="step === 0" class="step-body" v-loading="uploading">
								<p class="step-tip muted">
									简书「设置 → 账号管理 → 打包下载全部文章」，得到 rar / zip 后在此上传。
								</p>
								<el-upload
									v-if="!summary"
									drag
									:show-file-list="false"
									:http-request="doUpload"
									accept=".zip,.rar"
									class="upload-full"
								>
									<el-icon :size="44"><UploadFilled /></el-icon>
									<div class="upload-text">拖入或点击上传简书导出包</div>
									<div class="upload-sub muted">zip / rar，≤30MB</div>
								</el-upload>
								<div v-else class="parsed-box">
									<p class="parsed-line">
										✓ 已解析 <b>{{ summary.total }}</b> 篇 · {{ summary.notebooks.length }} 个文集
									</p>
									<el-button size="small" type="danger" plain @click="dropSession">换一个包</el-button>
								</div>

								<div class="step-footer">
									<el-button @click="mode = null">上一步</el-button>
									<el-button type="primary" :disabled="!summary" @click="step = 1">
										下一步
									</el-button>
								</div>
							</div>

							<!-- ===== 第 2 步：选择文章与选项 ===== -->
							<div v-else-if="step === 1" class="step-body">
								<div class="panel fill">
									<div class="panel-head">
										<span>文章清单 · 已选 {{ selectedCount }}/{{ summary?.total ?? 0 }}</span>
										<span class="head-ops">
											<el-button
												size="small"
												text
												type="primary"
												:disabled="selectedCount === selectableCount"
												@click="selectAll"
											>
												全选
											</el-button>
											<el-button size="small" text :disabled="selectedCount === 0" @click="clearAll">
												清空
											</el-button>
										</span>
									</div>
									<div class="notebook-list">
										<div v-for="nb in summary?.notebooks ?? []" :key="nb.name" class="notebook">
											<div class="notebook-head">
												<el-checkbox
													:model-value="groupChecked(nb.name)"
													@change="(v: string | number | boolean) => toggleGroup(nb.name, !!v)"
												>
													<span class="notebook-name">{{ nb.name }}</span>
												</el-checkbox>
												<span class="notebook-count muted">{{ nb.articles.length }} 篇</span>
											</div>
											<div v-for="a in nb.articles" :key="a.id" class="article-row">
												<el-checkbox
													:model-value="selectedIds.includes(a.id)"
													:disabled="importedSet.has(a.id)"
													@change="(v: string | number | boolean) => {
														if (v) selectedIds.push(a.id);
														else selectedIds = selectedIds.filter((x) => x !== a.id);
													}"
												>
													{{ a.title }}
												</el-checkbox>
												<el-tag v-if="importedSet.has(a.id)" size="small" type="info">已导入</el-tag>
												<el-button size="small" text type="primary" @click="openPreview(a.id)">
													预览
												</el-button>
											</div>
										</div>
									</div>
								</div>

								<div class="panel">
									<div class="panel-head">导入选项</div>
									<el-form label-width="120px" class="opts-form">
										<el-form-item label="发布日期">
											<el-date-picker
												v-model="published"
												type="date"
												value-format="YYYY-MM-DD"
												style="width: 180px"
											/>
										</el-form-item>
										<el-form-item label="分类取文集名">
											<el-switch v-model="categoryFromNotebook" />
										</el-form-item>
										<el-form-item v-if="!categoryFromNotebook" label="统一分类">
											<el-input v-model="category" placeholder="可空" style="width: 180px" />
										</el-form-item>
										<el-form-item label="标签">
											<el-select
												v-model="tags"
												multiple
												filterable
												allow-create
												default-first-option
												placeholder="可空"
												style="width: 320px"
											/>
										</el-form-item>
										<el-form-item label="图片本地化">
											<el-switch v-model="localizeImages" />
										</el-form-item>
										<el-form-item label="导入为草稿">
											<el-switch v-model="draft" />
										</el-form-item>
									</el-form>
								</div>

								<div class="step-footer">
									<el-button :disabled="running" @click="step = 0">上一步</el-button>
									<el-button type="primary" :disabled="selectedCount === 0" @click="step = 2">
										下一步
									</el-button>
								</div>
							</div>

							<!-- ===== 第 3 步：内容转换（执行导入，任务进度就地展示） ===== -->
							<div v-else-if="step === 2" class="step-body">
								<div class="panel convert-panel fill">
									<div class="panel-head">内容转换</div>
									<template v-if="!job">
										<p class="convert-line">
											将转换 <b>{{ selectedCount }}</b> 篇文章，图片{{
												localizeImages ? "自动下载到文章目录" : "保留远程链接"
											}}{{ draft ? "，并存为草稿" : "" }}。
										</p>
										<el-button
											type="primary"
											:loading="starting"
											:disabled="selectedCount === 0"
											@click="startImport"
										>
											开始转换
										</el-button>
									</template>
									<template v-else>
										<el-progress
											:percentage="!job.total ? 0 : Math.round((job.done / job.total) * 100)"
											:status="running ? undefined : 'success'"
										/>
										<p class="job-current muted">
											{{ running ? `正在处理：${job.current ?? "…"}` : `共处理 ${job.done}/${job.total} 篇` }}
										</p>
									</template>
								</div>

								<div class="step-footer">
									<el-button :disabled="running" @click="step = 1">上一步</el-button>
									<el-button type="primary" :disabled="!job || running" @click="step = 3">
										下一步
									</el-button>
								</div>
							</div>

							<!-- ===== 第 4 步：完成 ===== -->
							<div v-else class="step-body">
								<div class="panel">
									<div class="panel-head">
										<span>{{ running ? "正在导入" : `导入完成：成功 ${doneCount}/${job?.total ?? 0} 篇` }}</span>
									</div>
									<el-progress
										:percentage="!job?.total ? 0 : Math.round((job.done / job.total) * 100)"
										:status="running ? undefined : 'success'"
									/>
									<p class="job-current muted">
										{{ running ? `正在处理：${job?.current ?? "…"}` : `共处理 ${job?.done ?? 0}/${job?.total ?? 0} 篇` }}
									</p>
									<div class="job-results">
										<div
											v-for="(r, i) in job?.results ?? []"
											:key="i"
											class="result-row"
											:class="{ ok: r.ok, fail: !r.ok }"
										>
											<span class="result-title">{{ r.title }}</span>
											<span class="muted">{{ r.ok ? `图 ${r.images} 张` : r.error }}</span>
										</div>
									</div>
								</div>
								<div class="step-footer">
									<el-button @click="goPosts">去文章管理</el-button>
									<el-button type="primary" :disabled="running" @click="restart">导入下一包</el-button>
								</div>
							</div>
						</div>
					</div>
				</el-tab-pane>
			</el-tabs>
		</el-card>

		<!-- 单篇预览（导出包流程） -->
		<el-dialog v-model="previewVisible" :title="preview?.title ?? '加载中…'" width="760px" top="6vh" append-to-body>
			<div v-loading="previewLoading">
				<p v-if="preview" class="muted preview-meta">
					{{ preview.wordCount }} 字 · 图片 {{ preview.imageCount }} 张（保持远程链接，导入时按需本地化）
				</p>
				<MdPreview
					v-if="preview"
					editor-id="jianshu-preview"
					:model-value="preview.markdown"
					:sanitize="mediaSanitize"
				/>
			</div>
		</el-dialog>
	</div>
</template>

<style scoped>
	/* 整页卡片：占满页面并撑开，内容列在卡内滚动 */
	.import-view {
		height: 100%;
		display: flex;
	}
	.import-view :deep(.platform-tabs) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.import-view :deep(.platform-tabs > .el-tabs__header) {
		margin: 0 0 16px;
	}
	.import-view :deep(.el-tabs__item) {
		font-size: 20px;
	}
	.import-view :deep(.platform-tabs > .el-tabs__content) {
		flex: 1;
		min-height: 0;
	}
	.import-view :deep(.el-tab-pane) {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.mode-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding-right: 4px;
	}

	/* ---- 向导骨架：步骤条 + 步骤体铺满内容区 ---- */
	.wizard {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	.steps {
		flex: none;
		margin: 8px 0 22px;
	}
	.steps :deep(.el-step__title) {
		font-size: 20px;
		line-height: 1.4;
	}
	.step-body {
		flex: 1;
		min-height: 320px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}
	.step-tip {
		font-size: 20px;
		line-height: 1.6;
		margin: 0;
		text-align: center;
	}
	.step-footer {
		margin-top: auto;
		padding-top: 0;
		display: flex;
		justify-content: center;
		gap: 14px;
	}

	/* ---- 选择导入方式：方式卡片（垂直居中，紧凑突出） ---- */
	.mode-cards {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 26px;
		flex-wrap: wrap;
	}
	.mode-card {
		width: 280px;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 28px 22px 24px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		background: var(--el-bg-color);
		cursor: pointer;
		transition:
			transform 0.2s ease,
			border-color 0.2s ease;
	}
	.mode-card:hover {
		border-color: var(--el-color-primary-light-5);
	}
	.mode-card:active {
		transform: translateY(-1px);
	}
	.mode-icon {
		width: 58px;
		height: 58px;
		display: flex;
		align-items: center;
		justify-content: center;
		border-radius: 12px;
		color: var(--el-color-white);
		background: var(--el-color-primary);
		margin-bottom: 6px;
	}
	.mode-title {
		font-size: 22px;
		font-weight: 600;
	}
	.mode-desc {
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}

	/* ---- 导出包：上传 ---- */
	/* 左右 auto 边距会禁用 flex 交叉轴拉伸，必须显式 width 才能让 max-width 生效 */
	.upload-full {
		width: 100%;
		max-width: 780px;
		margin: 0 auto;
	}
	.upload-full :deep(.el-upload-dragger) {
		width: 100%;
	}
	.upload-full :deep(.el-upload-dragger) {
		padding: 56px 0;
		border-radius: 12px;
	}
	.upload-text {
		font-size: 20px;
		margin-top: 10px;
	}
	.upload-sub {
		font-size: 20px;
		margin-top: 4px;
	}
	.parsed-box {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		padding: 26px 0;
	}
	.parsed-line {
		font-size: 20px;
		margin: 0;
	}

	/* ---- 卡内分区：轻底描边面板 ---- */
	.panel {
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		background: var(--el-fill-color-light);
		padding: 16px 18px;
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		margin-bottom: 12px;
		font-weight: 600;
		font-size: 20px;
	}
	.head-ops {
		display: flex;
		gap: 2px;
	}

	/* ---- 填充型面板与清单（随步骤体高度拉伸） ---- */
	.panel.fill {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.notebook-list {
		flex: 1;
		min-height: 160px;
		overflow-y: auto;
	}
	.notebook {
		margin-bottom: 14px;
	}
	.notebook:last-child {
		margin-bottom: 0;
	}
	.notebook-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		border-bottom: 1px dashed var(--el-border-color-lighter);
		padding-bottom: 6px;
		margin-bottom: 6px;
	}
	.notebook-name {
		font-weight: 600;
		font-size: 20px;
	}
	.article-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-left: 24px;
	}
	.article-row :deep(.el-checkbox__label) {
		font-size: 20px;
	}

	/* ---- 表单与任务 ---- */
	.opts-form {
		max-width: 600px;
	}

	/* ---- 第 3 步：内容转换（确认摘要 + 执行，垂直居中） ---- */
	.convert-panel {
		text-align: center;
	}
	.convert-panel.fill {
		justify-content: center;
		align-items: center; /* 子项（按钮/进度条）不被 flex 拉伸铺满 */
		gap: 4px;
	}
	.convert-panel .panel-head {
		justify-content: center;
		margin-bottom: 4px;
	}
	.convert-panel .el-progress {
		max-width: 560px;
		margin: 0 auto;
	}
	.convert-line {
		font-size: 20px;
		line-height: 1.6;
		margin: 0 0 10px;
		max-width: 760px;
	}

	/* ---- 第 4 步：完成 ---- */
	.job-current {
		font-size: 20px;
		margin: 10px 0;
	}
	.job-results {
		max-height: 300px;
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.result-row {
		display: flex;
		gap: 12px;
		font-size: 20px;
	}
	.result-row .result-title {
		flex: none;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 600;
	}
	.result-row.ok .result-title {
		color: var(--el-color-success);
	}
	.result-row.fail {
		color: var(--el-color-danger);
	}
	.preview-meta {
		font-size: 20px;
		margin: 0 0 10px;
	}
	.import-view :deep(.md-editor-preview) {
		font-size: 20px;
	}
</style>
