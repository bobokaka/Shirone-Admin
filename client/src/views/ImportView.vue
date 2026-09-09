<script setup lang="ts">
	import { computed, onUnmounted, ref } from "vue";
	import { useRouter } from "vue-router";
	/** 平台 tab：当前仅简书，后续平台加 tab-pane 即可 */
	const activePlatform = ref("jianshu");
	import { ElMessage, ElMessageBox } from "element-plus";
	import type { UploadRequestOptions } from "element-plus";
	import { MdEditor, MdPreview, type ToolbarNames } from "md-editor-v3";
	import type {
		JianshuArchiveSummary,
		JianshuImportJob,
		JianshuPasteResult,
		JianshuPreview,
	} from "@shirone-admin/shared";
	import { importApi, postApi } from "../api";
	import { localMediaSanitize, postPreviewBody } from "../utils/content-media";

	const router = useRouter();

	/* ---------- 向导状态机：0 选择方式 → 1 提供内容 → 2 选择与设置 → 3 内容转换 → 4 完成 ---------- */
	const step = ref(0);
	const mode = ref<"archive" | "paste">("archive");
	const steps = computed(() =>
		mode.value === "archive"
			? ["选择导入方式", "上传导出包", "选择文章", "内容转换", "导入完成"]
			: ["选择导入方式", "粘贴内容", "内容转换", "文章信息", "导入完成"],
	);

	function chooseMode(m: "archive" | "paste"): void {
		mode.value = m;
		step.value = 1;
	}

	const today = (() => {
		const d = new Date();
		const p = (n: number) => String(n).padStart(2, "0");
		return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	})();

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
			step.value = 2;
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
			step.value = 1;
		}
	}

	/** 完成页：导入下一包 / 粘贴下一篇 → 回到第 1 步 */
	function restart(): void {
		if (mode.value === "paste") resetPaste();
		else {
			summary.value = null;
			selectedIds.value = [];
			job.value = null;
			jobId.value = "";
		}
		step.value = 1;
	}

	function goPosts(): void {
		router.push("/posts");
	}

	/* ---------- 单篇预览（导出包流程）---------- */
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

	/* ---------- 单篇粘贴（编辑器直接粘贴：富文本自动转 Markdown，左编辑右预览）---------- */
	/** 精简工具栏：仅常用排版（默认的保存/源码/全屏/预览切换等在此无意义） */
	const pasteToolbars: ToolbarNames[] = [
		"bold",
		"italic",
		"strikeThrough",
		"-",
		"title",
		"quote",
		"unorderedList",
		"orderedList",
		"-",
		"codeRow",
		"code",
		"link",
	];
	const pasteMd = ref("");
	const pasteLoading = ref(false);
	const converted = ref<{ wordCount: number; imageCount: number } | null>(null);
	/** 正文中远程图片数（去重），内容转换步摘要用 */
	const pasteImageCount = computed(
		() =>
			new Set([...pasteMd.value.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]))
				.size,
	);
	const pasteTitle = ref("");
	const pastePublished = ref(today);
	const pasteCategory = ref("");
	const pasteTags = ref<string[]>([]);
	const pasteDraft = ref(true);
	const pasting = ref(false);
	const pasteResult = ref<JianshuPasteResult | null>(null);
	/** 落仓后的正文（预览用；与 pasteMd 的差异在图片已本地化） */
	const convertedBody = ref("");
	/* 文章信息（第 4 步）：AI 分析正文补充的博客元信息，用户可改后定稿 */
	const pasteDescription = ref("");
	const suggesting = ref(false);
	const metaAiUsed = ref(true);
	const finalizing = ref(false);

	/** 编辑器粘贴捕获：富文本（text/html）转服务端转 Markdown 覆盖编辑区；纯文本交给编辑器默认行为 */
	async function onEditorPaste(ev: ClipboardEvent): Promise<void> {
		const dt = ev.clipboardData;
		if (!dt) return;
		const html = (dt.getData("text/html") ?? "").trim();
		if (html === "") return;
		ev.preventDefault();
		pasteLoading.value = true;
		try {
			const r = await importApi.pastePreview({ html });
			pasteMd.value = r.markdown;
			converted.value = { wordCount: r.wordCount, imageCount: r.imageCount };
			if (r.title) pasteTitle.value = r.title;
			pasteResult.value = null;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			pasteLoading.value = false;
		}
	}

	async function runPaste(): Promise<void> {
		if (pasteMd.value.trim() === "" || pasting.value) return;
		pasting.value = true;
		try {
			// 标题留空 → 先取 AI 建议（会一并拟标题），AI 不可用则正文首行兜底
			let suggested = false;
			if (pasteTitle.value.trim() === "") {
				await loadSuggestions();
				suggested = true;
			}
			if (pasteTitle.value.trim() === "") pasteTitle.value = fallbackTitle();
			pasteResult.value = await importApi.pasteRun({
				markdown: pasteMd.value,
				options: {
					title: pasteTitle.value.trim(),
					published: pastePublished.value,
					category: pasteCategory.value || undefined,
					tags: pasteTags.value,
					draft: pasteDraft.value,
				},
			});
			// 留在本步展示预览；取落仓正文（图片已重写为本地路径）
			convertedBody.value = (await postApi.detail(pasteResult.value.path)).body;
			ElMessage.success("转换完成");
			if (!suggested) void loadSuggestions(); // 文章信息步的 AI 建议提前预热
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			pasting.value = false;
		}
	}

	/** AI 分析正文 → 回填标题（留空时）/摘要/分类/标签（失败/未启用回退正文摘要，metaAiUsed=false 提示可手改） */
	async function loadSuggestions(): Promise<void> {
		if (pasteMd.value.trim() === "" || suggesting.value) return;
		suggesting.value = true;
		try {
			const r = await importApi.suggestMeta({
				title: pasteTitle.value.trim(),
				markdown: pasteMd.value,
			});
			if (r.title && pasteTitle.value.trim() === "") pasteTitle.value = r.title;
			pasteDescription.value = r.description;
			pasteCategory.value = r.category;
			pasteTags.value = r.tags;
			metaAiUsed.value = r.aiUsed;
		} catch (e) {
			metaAiUsed.value = false;
			ElMessage.error((e as Error).message);
		} finally {
			suggesting.value = false;
		}
	}

	/** 无标题且 AI 不可用时的兜底：正文首个非空行剥掉 markdown 记号，截 30 字 */
	function fallbackTitle(): string {
		const line =
			pasteMd.value
				.trim()
				.split(/\r?\n/)
				.map((l) => l.replace(/^#{1,6}\s*/, "").replace(/[*_`>~[\]()#]/g, "").trim())
				.find((l) => l !== "") ?? "";
		return line.slice(0, 30) || "未命名文章";
	}

	/** 文章信息定稿：把 AI 补充（或手改）的元信息写回已转换生成的文章 */
	async function finishPaste(): Promise<void> {
		if (!pasteResult.value || finalizing.value) return;
		finalizing.value = true;
		try {
			const f = await postApi.detail(pasteResult.value.path);
			await postApi.save({
				path: pasteResult.value.path,
				meta: {
					title: pasteTitle.value.trim(),
					published: pastePublished.value,
					category: pasteCategory.value || "",
					tags: pasteTags.value,
					description: pasteDescription.value.trim(),
					draft: pasteDraft.value,
				},
				body: f.body,
			});
			step.value = 4;
			ElMessage.success("导入完成");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			finalizing.value = false;
		}
	}

	/** 预览正文：./images/ 重写到 /content-posts/<slug>/（server 静态路由），失败远程图保持原链 */
	const previewBody = computed(() =>
		pasteResult.value ? postPreviewBody(convertedBody.value, pasteResult.value.path) : "",
	);

	/** md 预览的本地媒体地址（/ 与 assets/ 前缀）重写为代理直链 */
	function mediaSanitize(html: string): string {
		return localMediaSanitize(html);
	}

	function resetPaste(): void {
		pasteMd.value = "";
		converted.value = null;
		convertedBody.value = "";
		pasteTitle.value = "";
		pasteCategory.value = "";
		pasteTags.value = [];
		pasteResult.value = null;
		pasteDescription.value = "";
		metaAiUsed.value = true;
	}

	function goEdit(): void {
		if (pasteResult.value) router.push({ path: "/posts/edit", query: { path: pasteResult.value.path } });
	}

	/** 标题输入粘贴兜底：剪贴板只有富文本（无 text/plain，从网页复制常见）时提取纯文本，压成单行 */
	function onTitlePaste(ev: ClipboardEvent): void {
		const dt = ev.clipboardData;
		if (!dt) return;
		const plain = (dt.getData("text/plain") ?? "").trim();
		if (plain !== "") return; // 有纯文本走编辑器默认行为
		const html = (dt.getData("text/html") ?? "").trim();
		if (html === "") return;
		ev.preventDefault();
		const div = document.createElement("div");
		div.innerHTML = html;
		const text = (div.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text === "") return;
		const input = ev.target as HTMLInputElement;
		const start = input.selectionStart ?? pasteTitle.value.length;
		const end = input.selectionEnd ?? start;
		pasteTitle.value = (pasteTitle.value.slice(0, start) + text + pasteTitle.value.slice(end)).slice(0, 100);
	}

	/* ---------- 导出包：导入任务 ---------- */
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
				if (step.value === 3) step.value = 4; // 完成页仅在任务结束后进入
			}
		} catch (e) {
			clearInterval(timer);
			timer = undefined;
			ElMessage.error((e as Error).message);
		}
	}

	onUnmounted(() => clearInterval(timer));
</script>

<template>
	<!-- 整页玻璃卡：步骤条居中引导，每步一个主任务 -->
	<div class="import-view">
		<el-card class="page-card">
			<el-tabs v-model="activePlatform" class="platform-tabs">
				<el-tab-pane label="简书" name="jianshu" lazy>
					<div class="mode-scroll">
						<div class="wizard">
							<el-steps :active="step" align-center finish-status="success" class="steps">
								<el-step v-for="t in steps" :key="t" :title="t" />
							</el-steps>

							<!-- ===== 第 1 步：选择导入方式（垂直居中的选择卡） ===== -->
							<div v-if="step === 0" class="step-body">
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

							<!-- ===== 第 2 步：提供内容 ===== -->
							<div v-else-if="step === 1" class="step-body" v-loading="uploading || pasteLoading">
								<!-- 导出包 -->
								<template v-if="mode === 'archive'">
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
								</template>

								<!-- 单篇粘贴：标题输入 + 与文章编辑一致的编辑器（左编辑右预览），富文本粘贴自动转 Markdown -->
								<template v-else>
									<div class="paste-head">
										<span class="paste-head-label">文章标题</span>
										<el-input
											v-model="pasteTitle"
											size="large"
											clearable
											@paste="onTitlePaste"
										/>
									</div>
									<div class="paste-editor" v-loading="pasteLoading" @paste.capture="onEditorPaste">
										<MdEditor
											editor-id="jianshu-paste"
											v-model="pasteMd"
											:toolbars="pasteToolbars"
											:preview="true"
											:footers="[]"
											:sanitize="mediaSanitize"
											placeholder="在此粘贴文章内容…"
										/>
									</div>
									<p v-if="converted" class="muted converted-line">
										已转换：{{ converted.wordCount }} 字 · 图片 {{ converted.imageCount }} 张（导入时自动下载到文章目录）
									</p>
								</template>

								<div class="step-footer">
									<el-button @click="step = 0">上一步</el-button>
									<el-button
										type="primary"
										:disabled="mode === 'archive' ? !summary : pasteMd.trim() === ''"
										@click="step = 2"
									>
										下一步
									</el-button>
								</div>
							</div>

							<!-- ===== 第 3 步：选择与设置（导出包）/ 内容转换（单篇粘贴） ===== -->
							<div v-else-if="step === 2" class="step-body">
								<!-- 导出包：清单 + 选项 -->
								<template v-if="mode === 'archive'">
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
										<el-button :disabled="running" @click="step = 1">上一步</el-button>
										<el-button type="primary" :disabled="selectedCount === 0" @click="step = 3">
											下一步
										</el-button>
									</div>
								</template>

								<!-- 单篇粘贴：内容转换（图片本地化落仓；完成后停留本步预览，下一步再补信息） -->
								<template v-else>
									<div class="panel paste-convert fill">
										<div class="panel-head">
											<span>内容转换</span>
											<el-button
												v-if="pasteResult"
												size="small"
												text
												type="primary"
												:disabled="pasting"
												@click="runPaste"
											>
												重新转换
											</el-button>
										</div>

										<!-- 转换前：概要与启动 -->
										<div v-if="!pasteResult" class="convert-intro">
											<span class="convert-doc-icon"><el-icon :size="34"><Document /></el-icon></span>
											<div class="convert-doc">
												<div class="convert-doc-title">{{ pasteTitle || "未命名" }}</div>
												<div class="convert-doc-sub muted">
													正文 {{ converted?.wordCount ?? pasteMd.length }}
													{{ converted ? "字" : "字符" }} · 远程图片 {{ pasteImageCount }} 张
												</div>
											</div>
											<div class="convert-chips">
												<el-tag effect="plain" round>图片下载到文章目录</el-tag>
												<el-tag effect="plain" round>webp 自动转 png / jpg</el-tag>
											</div>
											<el-button
												type="primary"
												size="large"
												:loading="pasting"
												:disabled="pasteMd.trim() === ''"
												@click="runPaste"
											>
												开始转换
											</el-button>
										</div>

										<!-- 转换后：结果与预览 -->
										<template v-else>
											<p class="convert-done-line">
												<span class="ok-text">✓ 转换完成</span>
												<span class="muted">
													· 图片本地化 {{ pasteResult.images }} 张<template
														v-if="pasteResult.failedImages.length"
													>
														· {{ pasteResult.failedImages.length }} 张失败保留远程链接</template
													>
												</span>
											</p>
											<div class="convert-preview" v-loading="pasting">
												<MdPreview
													editor-id="jianshu-convert-preview"
													:model-value="previewBody"
													:sanitize="mediaSanitize"
												/>
											</div>
										</template>
									</div>

									<div class="step-footer">
										<el-button :disabled="pasting" @click="step = 1">上一步</el-button>
										<el-button type="primary" :disabled="!pasteResult" @click="step = 3">
											下一步
										</el-button>
									</div>
								</template>
							</div>

							<!-- ===== 第 4 步：内容转换（导出包执行导入）/ 文章信息（单篇粘贴 AI 补充） ===== -->
							<div v-else-if="step === 3" class="step-body">
								<!-- 导出包：确认并执行，任务进度就地展示 -->
								<div v-if="mode === 'archive'" class="panel convert-panel fill">
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

								<!-- 单篇粘贴：AI 分析补充的博客元信息，确认后写回文章 -->
								<div v-else class="panel meta-panel" v-loading="suggesting">
									<div class="panel-head">
										<span>文章信息</span>
										<el-button size="small" text type="primary" :disabled="suggesting" @click="loadSuggestions">
											重新分析
										</el-button>
									</div>
									<p class="muted paste-meta">
										{{
											metaAiUsed
												? "AI 已分析正文并填充以下信息，可修改。"
												: "AI 未启用或分析失败，已用正文摘要兜底，可手动修改。"
										}}
									</p>
									<el-form label-width="120px" class="opts-form">
										<el-form-item label="标题">
											<el-input
												v-model="pasteTitle"
												placeholder="AI 拟定或自动识别，可修改"
												style="width: 420px"
												@paste="onTitlePaste"
											/>
										</el-form-item>
										<el-form-item label="摘要">
											<el-input
												v-model="pasteDescription"
												type="textarea"
												:rows="3"
												maxlength="200"
												show-word-limit
												placeholder="列表与分享卡展示的一句话摘要"
											/>
										</el-form-item>
										<el-form-item label="分类">
											<el-input v-model="pasteCategory" placeholder="可空" style="width: 240px" />
										</el-form-item>
										<el-form-item label="标签">
											<el-select
												v-model="pasteTags"
												multiple
												filterable
												allow-create
												default-first-option
												placeholder="可空"
												style="width: 360px"
											/>
										</el-form-item>
										<el-form-item label="发布日期">
											<el-date-picker
												v-model="pastePublished"
												type="date"
												value-format="YYYY-MM-DD"
												style="width: 180px"
											/>
										</el-form-item>
										<el-form-item label="导入为草稿">
											<el-switch v-model="pasteDraft" />
										</el-form-item>
									</el-form>
								</div>

								<div class="step-footer">
									<template v-if="mode === 'archive'">
										<el-button :disabled="running" @click="step = 2">上一步</el-button>
										<el-button type="primary" :disabled="!job || running" @click="step = 4">
											下一步
										</el-button>
									</template>
									<template v-else>
										<el-button :disabled="finalizing" @click="step = 2">上一步</el-button>
										<el-button
											type="primary"
											:loading="finalizing"
											:disabled="suggesting"
											@click="finishPaste"
										>
											完成导入
										</el-button>
									</template>
								</div>
							</div>

							<!-- ===== 第 5 步：完成 ===== -->
							<div v-else class="step-body">
								<!-- 导出包：进度与结果 -->
								<template v-if="mode === 'archive'">
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
								</template>

								<!-- 单篇粘贴：结果 -->
								<template v-else>
									<div class="panel">
										<div class="panel-head">导入完成</div>
										<p class="done-line">
											✓ {{ pasteResult?.title }} → <code class="done-path">{{ pasteResult?.path }}</code>
											<span class="muted">（图片本地化 {{ pasteResult?.images ?? 0 }} 张）</span>
										</p>
										<div v-if="pasteResult?.failedImages.length" class="fail-list">
											<p>⚠ {{ pasteResult.failedImages.length }} 张图片下载失败，正文保留远程链接：</p>
											<p v-for="u in pasteResult.failedImages" :key="u" class="fail-url">{{ u }}</p>
										</div>
									</div>
									<div class="step-footer">
										<el-button @click="goEdit">去文章编辑</el-button>
										<el-button type="primary" @click="restart">粘贴下一篇</el-button>
									</div>
								</template>
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
	/* 简书 tab 头：独立渐变色卡，与下方内容区分开（四周留白，不贴底） */
	.import-view :deep(.platform-tabs > .el-tabs__header) {
		margin: 0 0 16px;
		padding: 8px 16px;
		background: linear-gradient(135deg, rgba(99, 102, 241, 0.1), rgba(192, 132, 252, 0.07));
		border: 1px solid rgba(99, 102, 241, 0.22);
		border-radius: 12px;
	}
	.import-view :deep(.platform-tabs > .el-tabs__header .el-tabs__nav-wrap::after) {
		display: none; /* 去默认灰线，改用色卡描边 */
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

	/* ---- 第 1 步：导入方式卡片（垂直居中，紧凑突出） ---- */
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
		border: 1px solid rgba(99, 102, 241, 0.16);
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.6);
		box-shadow: 0 6px 22px rgba(99, 102, 241, 0.08);
		cursor: pointer;
		transition:
			transform 0.2s ease,
			border-color 0.2s ease,
			box-shadow 0.2s ease;
	}
	.mode-card:hover {
		transform: translateY(-4px);
		border-color: rgba(99, 102, 241, 0.5);
		box-shadow: 0 14px 34px rgba(99, 102, 241, 0.2);
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
		border-radius: 16px;
		color: #fff;
		background: linear-gradient(135deg, var(--accent-a), var(--accent-b));
		box-shadow: 0 6px 16px rgba(99, 102, 241, 0.35);
		margin-bottom: 6px;
		transition: transform 0.2s ease;
	}
	.mode-card:hover .mode-icon {
		transform: scale(1.08);
	}
	.mode-title {
		font-size: 22px;
		font-weight: 600;
	}
	.mode-desc {
		font-size: 20px;
		color: var(--text-sub);
	}

	/* ---- 第 2 步：上传 / 粘贴 ---- */
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
	/* 粘贴步标题行：左侧文字标签 + 输入框，与编辑器同宽对齐（左右各 20px） */
	.paste-head {
		flex: none;
		margin: 0 20px 10px;
		display: flex;
		align-items: center;
		gap: 12px;
	}
	.paste-head-label {
		flex: none;
		font-size: 20px;
		color: var(--text-sub);
	}
	.paste-head :deep(.el-input) {
		flex: 1;
	}
	/* 粘贴编辑器：与文章编辑器同款（左编辑右预览），铺满步骤体剩余高度，左右各让 20px */
	.paste-editor {
		flex: 1;
		min-height: 0;
		margin: 0 20px;
	}
	.paste-editor :deep(.md-editor) {
		height: 100%;
	}
	/* 右侧预览灰底 + 细分割线，与左侧编辑区区分 */
	.paste-editor :deep(.md-editor-preview-wrapper) {
		border-left: 1px solid var(--hairline);
	}
	.paste-editor :deep(.md-editor-preview-wrapper),
	.paste-editor :deep(.md-editor-preview) {
		background: #fcfcfd;
	}
	.converted-line {
		font-size: 20px;
		margin: 0;
	}

	/* ---- 卡内分区：轻底描边面板 ---- */
	.panel {
		border: 1px solid var(--hairline);
		border-radius: 14px;
		background: rgba(255, 255, 255, 0.35);
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
		border-bottom: 1px dashed var(--hairline);
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

	/* ---- 表单与完成页 ---- */
	.opts-form {
		max-width: 600px;
	}
	.paste-meta {
		font-size: 20px;
		margin: 0;
	}

	/* ---- 第 4 步：内容转换（确认摘要 + 执行，垂直居中） ---- */
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

	/* ---- 第 3 步（单篇粘贴）：内容转换 —— 概要启动 / 完成后本步预览 ---- */
	.paste-convert .panel-head {
		margin-bottom: 14px;
	}
	.convert-intro {
		flex: 1;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 16px;
		text-align: center;
	}
	.convert-doc-icon {
		width: 84px;
		height: 84px;
		border-radius: 22px;
		display: flex;
		align-items: center;
		justify-content: center;
		color: #fff;
		background: linear-gradient(135deg, #6366f1, #c084fc);
		box-shadow: 0 10px 26px rgba(99, 102, 241, 0.35);
	}
	.convert-doc-title {
		font-size: 24px;
		font-weight: 600;
	}
	.convert-doc-sub {
		font-size: 20px;
	}
	.convert-chips {
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
		justify-content: center;
	}
	.convert-chips :deep(.el-tag) {
		font-size: 20px;
		padding: 8px 18px;
	}
	.convert-done-line {
		font-size: 20px;
		margin: 0 0 12px;
	}
	.convert-done-line .ok-text {
		color: var(--el-color-success);
		font-weight: 600;
	}
	.convert-preview {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		border: 1px solid var(--hairline);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.5);
		padding: 6px 16px;
	}
	.convert-preview :deep(.md-editor-preview) {
		font-size: 20px;
		color: var(--text-main);
	}
	.meta-panel {
		width: 100%;
		max-width: 780px;
		margin: 0 auto;
	}
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
	.done-line {
		font-size: 20px;
		margin: 0 0 4px;
	}
	.done-path {
		font-family: Consolas, monospace;
	}
	.fail-list p {
		font-size: 20px;
		margin: 4px 0;
		color: var(--el-color-warning);
	}
	.fail-url {
		font-family: Consolas, monospace;
		word-break: break-all;
	}
	.preview-meta {
		font-size: 20px;
		margin: 0 0 10px;
	}
	.import-view :deep(.md-editor-preview) {
		font-size: 20px;
	}
</style>
