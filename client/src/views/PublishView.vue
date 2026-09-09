<script setup lang="ts">
	import { computed, onBeforeUnmount, onMounted, ref } from "vue";
	import { ElMessage } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type {
		PublishPreview,
		PublishResult,
		RemoteProbe,
		RepoPublishResult,
		RepoTarget,
	} from "@shirone-admin/shared";
	import { aiApi, publishApi } from "../api";
	import { useSystemStore } from "../stores/system";

	const sys = useSystemStore();
	const preview = ref<PublishPreview | null>(null);
	const message = ref("");
	const themeMessage = ref("");
	const loading = ref(false);
	const publishing = ref(false);
	const validating = ref(false);
	const generating = ref<{ content: boolean; theme: boolean }>({ content: false, theme: false });
	const output = ref<{ ok: boolean; text: string } | null>(null);
	const aiEnabled = ref(false);
	/** 最近一次自动/生成填入的信息：refresh 时只有未被用户手改才回填（两输入框各自独立） */
	let lastAutoMessage = "";
	let lastAutoThemeMessage = "";

	const rootEl = ref<HTMLElement | null>(null);
	/** 两卡各自的当前仓切换（互不联动）：仓库状态 / 最近提交 */
	const statusRepoTab = ref<RepoTarget>("content");
	const commitsRepoTab = ref<RepoTarget>("content");
	const activeCommits = computed(() =>
		commitsRepoTab.value === "theme" ? (preview.value?.themeRecent ?? []) : (preview.value?.recent ?? []),
	);
	const repoTabOptions = [
		{ label: "内容仓", value: "content" },
		{ label: "主题仓", value: "theme" },
	];
	/** 落后远端比对（ls-remote）中 */
	const fetching = ref(false);
	/** 各仓远端比对结果（按仓独立缓存；整页刷新 preview 时作废重置） */
	const remoteProbe = ref<{ content: RemoteProbe | null; theme: RemoteProbe | null }>({
		content: null,
		theme: null,
	});

	/* ---------- 提交信息输入：内容超宽时悬浮横向滚动展示 ---------- */

	let marqueeRaf = 0;

	function cancelMarquee(): void {
		if (marqueeRaf) cancelAnimationFrame(marqueeRaf);
		marqueeRaf = 0;
	}

	/** 从事件源（el-input 根节点或 input 本身）解析输入框元素 */
	function inputOf(ev: Event): HTMLInputElement | null {
		const t = ev.currentTarget as HTMLElement | null;
		if (!t) return null;
		if (t instanceof HTMLInputElement) return t;
		return t.querySelector<HTMLInputElement>("input");
	}

	function stopMarquee(ev: Event, reset = true): void {
		cancelMarquee();
		if (reset) {
			const el = inputOf(ev);
			if (el) el.scrollLeft = 0;
		}
	}

	/** 悬浮期间循环滚动：滚到末尾再滚回开头，单程时长随溢出宽度缩放 */
	function startMarquee(ev: Event): void {
		cancelMarquee();
		const el = inputOf(ev);
		if (!el || el.scrollWidth <= el.clientWidth + 2) return;
		const max = el.scrollWidth - el.clientWidth;
		const per = Math.max(1400, max * 22);
		const t0 = performance.now();
		const step = (now: number): void => {
			const t = (((now - t0) / per) % 2 + 2) % 2;
			const phase = t < 1 ? t : 2 - t;
			el.scrollLeft = Math.round(max * phase);
			marqueeRaf = requestAnimationFrame(step);
		};
		marqueeRaf = requestAnimationFrame(step);
	}

	onBeforeUnmount(cancelMarquee);

	const fileCount = computed(() => preview.value?.files.length ?? 0);
	const themeFileCount = computed(() => preview.value?.themeChanges.length ?? 0);

	/** path 前缀 → 展示标签 */
	function pathTag(path: string, repo: RepoTarget = "content"): string {
		if (repo === "theme") {
			if (path.startsWith("src/content/")) return "内容同步";
			if (path.startsWith("public/") || path.startsWith("src/assets/")) return "资源";
			if (path.startsWith("scripts/")) return "脚本";
			if (path.startsWith(".github/")) return "工作流";
			if (path.startsWith("docs/") || path === "README.md") return "文档";
			if (path.startsWith("src/")) return "源码";
			return "配置";
		}
		if (path.startsWith("content/posts/")) return "文章";
		if (path.startsWith("content/moments/")) return "说说";
		if (path.startsWith("data/")) return "数据";
		if (path.startsWith("config/")) return "配置";
		if (path.startsWith("assets/") || path.startsWith("public/")) return "资源";
		return "其他";
	}

	/** 内容仓聚合摘要一行（如「2 篇新文章 · 1 条说说 · 3 个数据文件」） */
	const contentSummary = computed(() => {
		const c = preview.value?.changes ?? [];
		if (c.length === 0) return "";
		const posts = new Set(
			c.filter((f) => f.path.startsWith("content/posts/")).map((f) => f.path.slice("content/posts/".length).split("/")[0]),
		);
		const newPosts = [...posts].filter((slug) =>
			c.some((f) => f.path.startsWith(`content/posts/${slug}/`) && f.state === "new"),
		).length;
		const moments = c.filter((f) => f.path.startsWith("content/moments/")).length;
		const data = c.filter((f) => f.path.startsWith("data/")).length;
		const parts: string[] = [];
		if (posts.size > 0) parts.push(newPosts >= posts.size ? `${posts.size} 篇新文章` : `${newPosts} 新 / ${posts.size - newPosts} 改文章`);
		if (moments > 0) parts.push(`${moments} 条说说`);
		if (data > 0) parts.push(`${data} 个数据文件`);
		const rest = c.length - posts.size - moments - data;
		if (rest > 0) parts.push(`${rest} 个其他文件`);
		return parts.join(" · ");
	});

	/** 主题仓聚合摘要一行（按展示标签计数，如「2 个资源 · 1 个文档」） */
	const themeSummary = computed(() => {
		const c = preview.value?.themeChanges ?? [];
		if (c.length === 0) return "";
		const counts = new Map<string, number>();
		for (const f of c) {
			const tag = pathTag(f.path, "theme");
			counts.set(tag, (counts.get(tag) ?? 0) + 1);
		}
		return [...counts.entries()].map(([tag, n]) => `${n} 个${tag}`).join(" · ");
	});

	/** 提交信息实时格式校验：空 = 合法（自动生成）；非空须 type(scope): 描述 */
	function checkCommitMessage(raw: string): { ok: boolean; text: string } {
		if (raw === "") return { ok: true, text: "留空按变更内容自动生成" };
		const m = raw.match(/^(feat|fix|test|docs|refactor|chore)\([\w-]+\): (.+)$/s);
		if (!m || m[2].length > 30) return { ok: false, text: "格式：type(scope): 中文 ≤30 字" };
		return { ok: true, text: "✓ 符合规范" };
	}
	const contentCheck = computed(() => checkCommitMessage(message.value.trim()));
	const themeCheck = computed(() => {
		if (themeFileCount.value === 0 && themeMessage.value.trim() === "") {
			return { ok: true, text: "暂无变更，留空自动生成" };
		}
		return checkCommitMessage(themeMessage.value.trim());
	});

	function applyMessage(next: string, repo: RepoTarget = "content"): void {
		if (repo === "theme") {
			themeMessage.value = next;
			lastAutoThemeMessage = next;
		} else {
			message.value = next;
			lastAutoMessage = next;
		}
	}

	/** 应用新 preview：未被用户手改（仍为空或仍是上次自动值）的提交信息才回填；旧的远端比对结果随之作废 */
	function applyPreview(next: PublishPreview): void {
		preview.value = next;
		remoteProbe.value = { content: null, theme: null };
		if (message.value === "" || message.value === lastAutoMessage) applyMessage(next.message);
		if (themeMessage.value === "" || themeMessage.value === lastAutoThemeMessage) {
			applyMessage(next.themeMessage, "theme");
		}
	}

	async function refresh(): Promise<void> {
		loading.value = true;
		try {
			applyPreview(await publishApi.preview());
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loading.value = false;
		}
	}

	/** 落后远端是本地缓存值：点按钮用 ls-remote 与远端分支 tip 比对（不拉取任何代码） */
	async function refreshBehind(): Promise<void> {
		fetching.value = true;
		try {
			const repo = statusRepoTab.value;
			const next = { ...remoteProbe.value };
			next[repo] = await publishApi.probeRepo(repo);
			remoteProbe.value = next;
			ElMessage.success("已与远端比对");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			fetching.value = false;
		}
	}

	/** 落后远端文案：比对过以远端 tip 结果为准；两仓推送前都自动 rebase */
	function behindText(cached: number, probe: RemoteProbe | null, hint = ""): string {
		const n = probe ? probe.behind : cached;
		if (n === 0) return "0（已是最新）";
		if (n === null) return "远端有新提交（数量需拉取后可知）";
		return `${n} 个提交${hint}`;
	}

	async function aiGenerate(repo: RepoTarget): Promise<void> {
		generating.value[repo] = true;
		try {
			const r = await aiApi.commitMessage(repo);
			applyMessage(r.message, repo);
			if (r.source === "heuristic") {
				ElMessage.info("AI 未产出合规信息，已回退按变更内容自动生成");
			} else {
				ElMessage.success("已生成，可继续手改");
			}
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			generating.value[repo] = false;
		}
	}

	async function validateOnly(): Promise<void> {
		validating.value = true;
		try {
			const r = await publishApi.validate();
			output.value = { ok: r.ok, text: r.output || "(无输出)" };
			ElMessage[r.ok ? "success" : "error"](r.ok ? "校验通过" : "校验未通过，见左侧输出");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			validating.value = false;
		}
	}

	/** 双仓结果拼执行输出：【内容仓】/【主题仓】各一段 */
	function dualOutputText(r: PublishResult): string {
		const section = (name: string, res: RepoPublishResult): string =>
			[`【${name}】`, ...res.log, res.validationOutput ?? ""].filter(Boolean).join("\n");
		return [section("内容仓", r.content), "", section("主题仓", r.theme)].join("\n");
	}

	async function run(): Promise<void> {
		publishing.value = true;
		try {
			const r: PublishResult = await publishApi.run({
				contentMessage: message.value.trim() || undefined,
				themeMessage: themeMessage.value.trim() || undefined,
			});
			output.value = { ok: r.ok, text: dualOutputText(r) };
			const pushedAny = r.content.pushed || r.theme.pushed;
			if (r.ok && pushedAny) {
				ElMessage.success("已推送，将自动构建上线");
			} else if (r.ok) {
				ElMessage.info("没有需要发布的内容");
			} else if (!r.content.ok && !r.theme.ok) {
				ElMessage.error("发布失败，详见执行输出");
			} else {
				ElMessage.warning("部分仓库发布失败，详见执行输出");
			}
			await refresh();
			await sys.refresh().catch(() => {});
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			publishing.value = false;
		}
	}

	onMounted(() => {
		void refresh();
		aiApi
			.getSettings()
			.then((s) => (aiEnabled.value = s.enable))
			.catch(() => {});
	});
</script>

<template>
	<div ref="rootEl" v-loading="loading" class="publish">
		<!-- 左栏：提交信息 + 仓库状态 + 最近提交 + 执行输出 -->
		<div class="pub-left">
			<el-card shadow="never">
				<template #header>提交信息</template>
				<div class="msg-head">
					<span class="msg-title">内容仓</span>
					<el-button
						v-if="aiEnabled"
						:loading="generating.content"
						:disabled="fileCount === 0"
						@click="aiGenerate('content')"
					>
						<el-icon v-if="!generating.content"><Icon icon="material-symbols:auto-awesome" /></el-icon>AI生成
					</el-button>
				</div>
				<el-input
					v-model="message"
					placeholder="留空自动生成"
					maxlength="60"
					show-word-limit
					:class="['msg-input', { 'msg-invalid': !contentCheck.ok }]"
					@mouseenter="startMarquee($event)"
					@mouseleave="stopMarquee($event)"
					@focus="stopMarquee($event, false)"
				/>
				<div class="check" :class="contentCheck.ok ? 'check-ok' : 'check-bad'">
					{{ contentCheck.text }}
				</div>
				<!-- 主题仓输入框常驻：无变更时空置，发布时自动跳过该仓 -->
				<div class="msg-head msg-head-gap">
					<span class="msg-title">主题仓</span>
					<el-button
						v-if="aiEnabled"
						:loading="generating.theme"
						:disabled="themeFileCount === 0"
						@click="aiGenerate('theme')"
					>
						<el-icon v-if="!generating.theme"><Icon icon="material-symbols:auto-awesome" /></el-icon>AI生成
					</el-button>
				</div>
				<el-input
					v-model="themeMessage"
					placeholder="留空自动生成"
					maxlength="60"
					show-word-limit
					:class="['msg-input', { 'msg-invalid': !themeCheck.ok }]"
					@mouseenter="startMarquee($event)"
					@mouseleave="stopMarquee($event)"
					@focus="stopMarquee($event, false)"
				/>
				<div class="check" :class="themeCheck.ok ? 'check-ok' : 'check-bad'">
					{{ themeCheck.text }}
				</div>
				<div class="actions">
					<el-button :loading="validating" @click="validateOnly">仅校验</el-button>
					<el-button
						type="primary"
						:loading="publishing"
						:disabled="fileCount === 0 && themeFileCount === 0"
						@click="run"
					>
						一键发布
					</el-button>
				</div>
			</el-card>

			<el-card shadow="never">
				<template #header>
					<div class="card-head">
						<span>仓库状态</span>
						<el-segmented v-model="statusRepoTab" :options="repoTabOptions" size="small" />
					</div>
				</template>
				<!-- 两仓面板同格叠放（见 .status-panels）：高度恒取最高面板，tab 切换不抖动 -->
				<div class="status-panels">
					<!-- 内容仓：发布目标仓，含主题依赖（决定能否本地校验） -->
					<el-descriptions
						v-if="preview"
						:class="{ 'panel-hidden': statusRepoTab !== 'content' }"
						:column="1"
						border
					>
						<el-descriptions-item label="分支">{{ preview.branch }}</el-descriptions-item>
						<el-descriptions-item label="本地领先">{{ preview.ahead }} 个提交未推送</el-descriptions-item>
						<el-descriptions-item label="落后远端">
							{{ behindText(preview.behind, remoteProbe.content, "（推送前自动 rebase）") }}
							<el-button
								class="behind-btn"
								size="small"
								circle
								:loading="fetching"
								title="与远端比对（不拉取代码）"
								@click="refreshBehind"
							>
								<el-icon v-if="!fetching"><Icon icon="material-symbols:refresh" /></el-icon>
							</el-button>
						</el-descriptions-item>
						<el-descriptions-item label="主题依赖">
							{{ preview.themeDepsInstalled ? "已安装（可本地校验）" : "未安装（无法校验）" }}
						</el-descriptions-item>
					</el-descriptions>
					<!-- 主题仓：发布目标仓（提交+推送，无本地校验，由其自身 CI 把关） -->
					<el-descriptions
						v-if="preview?.themeStatus"
						:class="{ 'panel-hidden': statusRepoTab !== 'theme' }"
						:column="1"
						border
					>
						<el-descriptions-item label="分支">{{ preview.themeStatus.branch }}</el-descriptions-item>
						<el-descriptions-item label="本地领先">{{ preview.themeStatus.ahead }} 个提交未推送</el-descriptions-item>
						<el-descriptions-item label="落后远端">
							{{ behindText(preview.themeStatus.behind, remoteProbe.theme, "（推送前自动 rebase）") }}
							<el-button
								class="behind-btn"
								size="small"
								circle
								:loading="fetching"
								title="与远端比对（不拉取代码）"
								@click="refreshBehind"
							>
								<el-icon v-if="!fetching"><Icon icon="material-symbols:refresh" /></el-icon>
							</el-button>
						</el-descriptions-item>
					</el-descriptions>
					<!-- 当前仓无数据时的空态（同样叠放在格子里，不改变卡片高度） -->
					<p
						v-if="!preview || (statusRepoTab === 'theme' && !preview.themeStatus)"
						class="muted empty-tip"
					>
						未获取到仓库状态
					</p>
				</div>
			</el-card>

			<!-- 两仓提交用头部小型分段选择器切换；Admin 自身仓与发布无关，不在此显示 -->
			<el-card shadow="never" class="fill-card">
				<template #header>
					<div class="card-head">
						<span>最近提交</span>
						<el-segmented v-model="commitsRepoTab" :options="repoTabOptions" size="small" />
					</div>
				</template>
				<!-- 与右栏变更表同款：行线 + 悬浮高亮 + 表体内部滚动；列自明，不渲染表头 -->
				<div v-if="activeCommits.length" class="table-wrap">
					<el-table :data="activeCommits" height="100%" :show-header="false">
						<el-table-column width="110">
							<template #default="{ row }">
								<span class="commit-hash">{{ row.hash }}</span>
							</template>
						</el-table-column>
						<el-table-column min-width="120" show-overflow-tooltip>
							<template #default="{ row }">{{ row.subject }}</template>
						</el-table-column>
						<el-table-column width="90" align="right">
							<template #default="{ row }">
								<span class="commit-date">{{ row.date.slice(5) }}</span>
							</template>
						</el-table-column>
					</el-table>
				</div>
				<p v-else class="muted empty-tip">暂无提交记录</p>
			</el-card>

			<el-card v-if="output" shadow="never" class="output-card">
				<template #header>
					执行输出
					<el-tag :type="output.ok ? 'success' : 'danger'" size="small" style="margin-left: 8px">
						{{ output.ok ? "成功" : "失败" }}
					</el-tag>
				</template>
				<pre class="output pre-wrap">{{ output.text }}</pre>
			</el-card>
		</div>

		<!-- 右栏：待发布变更，两仓并排两列直出，各自列表内部滚动 -->
		<el-card shadow="never" class="changes-card">
			<template #header>
				<div class="card-head">
					<span>待发布变更</span>
					<el-button size="small" @click="refresh">刷新</el-button>
				</div>
			</template>
			<div class="changes-cols">
				<div class="repo-col">
					<div class="repo-col-head">
						内容仓<em v-if="fileCount">（{{ fileCount }} 个文件）</em>
					</div>
					<div v-if="contentSummary" class="summary">{{ contentSummary }}</div>
					<div v-if="fileCount > 0" class="table-wrap">
						<el-table :data="preview?.changes ?? []" height="100%">
							<el-table-column label="类型" width="110">
								<template #default="{ row }">
									<el-tag size="small" class="type-tag">{{ pathTag(row.path, "content") }}</el-tag>
								</template>
							</el-table-column>
							<el-table-column label="路径" min-width="140" show-overflow-tooltip>
								<template #default="{ row }">
									<span class="path">{{ row.path }}</span>
								</template>
							</el-table-column>
							<el-table-column label="变更" width="90">
								<template #default="{ row }">
									<el-tag size="small" :type="row.state === 'new' ? 'success' : 'warning'" effect="plain">
										{{ row.state === "new" ? "新增" : "修改" }}
									</el-tag>
								</template>
							</el-table-column>
						</el-table>
					</div>
					<p v-else class="muted col-empty">没有待发布的变更</p>
				</div>
				<div class="repo-col">
					<div class="repo-col-head">
						主题仓<em v-if="themeFileCount">（{{ themeFileCount }} 个文件）</em>
					</div>
					<div v-if="themeSummary" class="summary">{{ themeSummary }}</div>
					<div v-if="themeFileCount > 0" class="table-wrap">
						<el-table :data="preview?.themeChanges ?? []" height="100%">
							<el-table-column label="类型" width="110">
								<template #default="{ row }">
									<el-tag size="small" class="type-tag">{{ pathTag(row.path, "theme") }}</el-tag>
								</template>
							</el-table-column>
							<el-table-column label="路径" min-width="140" show-overflow-tooltip>
								<template #default="{ row }">
									<span class="path">{{ row.path }}</span>
								</template>
							</el-table-column>
							<el-table-column label="变更" width="90">
								<template #default="{ row }">
									<el-tag size="small" :type="row.state === 'new' ? 'success' : 'warning'" effect="plain">
										{{ row.state === "new" ? "新增" : "修改" }}
									</el-tag>
								</template>
							</el-table-column>
						</el-table>
					</div>
					<p v-else class="muted col-empty">主题仓没有待提交变更</p>
				</div>
			</div>
		</el-card>
	</div>
</template>

<style scoped>
	/* 左窄右宽双栏：左 = 提交信息/仓库状态/最近提交/输出，右 = 变更列表（内部滚动） */
	.publish {
		height: 100%;
		display: flex;
		gap: 14px;
		align-items: stretch;
	}
	.pub-left {
		flex: 0 0 640px;
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
		gap: 14px;
		overflow-y: auto;
		padding-right: 2px;
	}
	.pub-left > .el-card {
		flex: none;
	}
	/* 最近提交卡片占满左栏剩余高度（不低于 180px）：列表在卡片内滚动，而非撑长整列 */
	.pub-left > .fill-card {
		flex: 1 1 auto;
		min-height: 180px;
	}
	.changes-card,
	.fill-card {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.changes-card {
		min-width: 0;
	}
	.changes-card :deep(.el-card__body),
	.fill-card :deep(.el-card__body) {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.card-head em {
		font-style: normal;
		font-weight: 400;
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}
	.card-head-right {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	/* 头部分段切换（仓库状态/最近提交）：紧凑控件，字号 18px */
	.pub-left :deep(.el-segmented) {
		font-size: 18px;
	}
	/* 落后远端行内的刷新按钮：与 20px 正文对齐 */
	.behind-btn {
		margin-left: 8px;
		vertical-align: middle;
	}
	/* 仓库状态两仓面板同格叠放：卡片高度恒取最高面板（内容仓 4 行），tab 切换不抖动 */
	.status-panels {
		display: grid;
	}
	.status-panels > * {
		grid-area: 1 / 1;
	}
	/* 非当前仓面板仅隐藏占位（保留高度、不可交互） */
	.status-panels .panel-hidden {
		visibility: hidden;
		pointer-events: none;
	}
	.summary {
		flex: none;
		font-size: 20px;
		color: var(--el-text-color-regular);
		background: var(--el-fill-color-light);
		border-radius: 4px;
		padding: 6px 10px;
		margin-bottom: 10px;
	}
	/* 右栏两仓并排：等宽两列，各自独立滚动 */
	.changes-cols {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 14px;
	}
	.repo-col {
		min-width: 0;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
	.repo-col-head {
		flex: none;
		font-size: 20px;
		margin-bottom: 8px;
	}
	.repo-col-head em {
		font-style: normal;
		font-weight: 400;
		color: var(--el-text-color-secondary);
	}
	.repo-col .summary {
		margin-bottom: 8px;
	}
	.col-empty {
		flex: 1;
		display: flex;
		align-items: center;
		justify-content: center;
		margin: 0;
		font-size: 20px;
	}
	/* 表格外层（变更表/最近提交共用）：占满卡片剩余高度，表体内部滚动（有表头时吸顶） */
	.table-wrap {
		flex: 1;
		min-height: 0;
	}
	.path {
		font-family: Consolas, monospace;
	}
	.type-tag {
		min-width: 56px;
		justify-content: center;
	}
	.commit-hash {
		flex: none;
		font-family: Consolas, monospace;
		color: var(--el-color-primary);
	}
	.commit-date {
		flex: none;
		color: var(--el-text-color-secondary);
	}
	/* 提交信息输入组标题行：仓别名 + 该仓 AI 生成按钮 */
	.msg-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 6px;
	}
	.msg-head-gap {
		margin-top: 14px;
	}
	.msg-title {
		font-size: 20px;
	}
	.actions {
		margin-top: 14px;
		display: flex;
		gap: 10px;
		flex-wrap: wrap;
	}
	.check {
		font-size: 20px;
		margin-top: 6px;
	}
	.msg-input :deep(.el-input__inner) {
		font-size: 20px;
	}
	.msg-input :deep(.el-input__count) {
		font-size: 20px;
	}
	.check-ok {
		color: var(--el-color-success);
	}
	.check-bad {
		color: var(--el-color-danger);
	}
	.msg-invalid :deep(.el-input__wrapper) {
		box-shadow: 0 0 0 1px var(--el-color-danger) inset;
	}
	.output-card {
		flex: none;
	}
	.output {
		margin: 0;
		max-height: 200px;
		overflow-y: auto;
		font-family: Consolas, monospace;
		font-size: 20px;
	}
	.empty-tip {
		font-size: 20px;
		margin: 0;
		padding: 4px 0;
	}
	.muted {
		color: var(--el-text-color-secondary);
	}
</style>
