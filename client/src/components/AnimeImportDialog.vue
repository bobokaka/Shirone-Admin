<script setup lang="ts">
	import { computed, ref } from "vue";
	import { ElMessage } from "element-plus";
	import type { BangumiCandidate, BangumiDetail, SiteMediaResult } from "@shirone-admin/shared";
	import { aiApi, bangumiApi } from "../api";
	import { parseLooseJson } from "../utils/looseJson";
	import type { AnimeImportPayload } from "../types/imports";

	/**
	 * 番剧搜索导入：Bangumi 检索候选 → 选中取详情（封面自动落内容仓，失败不阻断）→
	 * 可选 AI 润色简介与类型（失败回退原始数据）→ emit 载荷由 DataView 填入新建草稿。
	 * 不依赖 AI 配置即可用；status/rating/watched 由用户在编辑弹窗自行决定。
	 */
	const visible = defineModel<boolean>({ default: false });
	defineProps<{ aiEnabled?: boolean }>();
	const emit = defineEmits<{ apply: [payload: AnimeImportPayload] }>();

	const keyword = ref("");
	const searching = ref(false);
	const searched = ref(false);
	const candidates = ref<BangumiCandidate[]>([]);

	const detail = ref<BangumiDetail | null>(null);
	const detailLoading = ref(false);
	const coverResult = ref<SiteMediaResult | null>(null);
	const coverFailed = ref(false);

	const aiPolish = ref(true);
	const applying = ref(false);

	/** 详情封面预览：本地入库后走 server 预览地址，未入库/失败时回退 Bangumi 图床 */
	const coverSrc = computed(() => coverResult.value?.previewUrl ?? detail.value?.cover ?? "");
	const periodText = computed(() => {
		const p = detail.value?.period;
		return p ? `${p.start}${p.end ? ` ~ ${p.end}` : ""}` : "";
	});

	async function doSearch(): Promise<void> {
		const kw = keyword.value.trim();
		if (kw === "") {
			ElMessage.warning("请输入番剧名称");
			return;
		}
		if (searching.value) return;
		searching.value = true;
		detail.value = null;
		try {
			const r = await bangumiApi.search(kw);
			candidates.value = r.candidates;
			searched.value = true;
			if (r.candidates.length === 0) ElMessage.info("没有找到相关条目，换个关键词试试");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			searching.value = false;
		}
	}

	async function pick(c: BangumiCandidate): Promise<void> {
		if (detailLoading.value) return;
		detailLoading.value = true;
		coverResult.value = null;
		coverFailed.value = false;
		try {
			const d = await bangumiApi.subject(c.id);
			detail.value = d;
			if (d.cover) {
				try {
					coverResult.value = await bangumiApi.coverImport({ url: d.cover, title: d.title });
				} catch (e) {
					coverFailed.value = true;
					ElMessage.warning(`封面下载失败：${(e as Error).message}`);
				}
			}
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			detailLoading.value = false;
		}
	}

	/** AI 润色：严格 JSON 输出，解析失败抛错由调用方回退 */
	async function polishWithAi(d: BangumiDetail): Promise<{ description: string; genres: string[] }> {
		const r = await aiApi.chat(
			[
				{
					role: "system",
					content: "你是番剧条目编辑助手。只输出一个 JSON 对象，不要任何解释、前后缀或代码围栏。",
				},
				{
					role: "user",
					content:
						`为个人博客的番剧条目润色信息。description：改写为 60-120 字中文简介，客观陈述、不含关键剧透；` +
						`genres：2-4 个中文类型词（如 奇幻/冒险/日常）。\n` +
						`只输出 JSON，形如 {"description":"…","genres":["…"]}。\n\n` +
						`标题：${d.title}\n原名：${d.originalTitle}\n现有简介：${d.summary}\n现有标签：${d.genres.join("、")}`,
				},
			],
			1024,
		);
		const parsed = parseLooseJson(r.content) as { description?: unknown; genres?: unknown } | null;
		const description =
			typeof parsed?.description === "string" && parsed.description.trim() !== ""
				? parsed.description.trim()
				: "";
		const genres = Array.isArray(parsed?.genres)
			? parsed.genres
					.filter((g): g is string => typeof g === "string" && g.trim() !== "")
					.map((g) => g.trim())
					.slice(0, 4)
			: [];
		if (description === "" && genres.length === 0) throw new Error("AI 未返回有效的 JSON 结果");
		return {
			description: description !== "" ? description : d.summary,
			genres: genres.length > 0 ? genres : d.genres,
		};
	}

	async function confirmApply(): Promise<void> {
		const d = detail.value;
		if (!d || applying.value) return;
		applying.value = true;
		try {
			let description = d.summary;
			let genres = d.genres;
			if (aiPolish.value) {
				try {
					const r = await polishWithAi(d);
					description = r.description;
					genres = r.genres;
					ElMessage.success("AI 已润色简介与类型");
				} catch (e) {
					ElMessage.warning(`AI 润色失败，使用原始数据：${(e as Error).message}`);
				}
			}
			emit("apply", {
				title: d.title,
				year: d.year,
				genres,
				description,
				cover: coverResult.value?.src,
				studio: d.studio,
				link: d.link,
				period: d.period,
				eps: d.eps,
			});
			visible.value = false;
			detail.value = null;
		} finally {
			applying.value = false;
		}
	}
</script>

<template>
	<el-dialog v-model="visible" title="搜索导入番剧" width="760px" top="6vh" class="anime-import-dialog">
		<div class="search-bar">
			<el-input
				v-model="keyword"
				placeholder="番剧名称，如 葬送的芙莉莲"
				clearable
				@keydown.enter.prevent="doSearch"
			/>
			<el-button type="primary" :loading="searching" @click="doSearch">搜索</el-button>
		</div>

		<!-- 候选列表 -->
		<div v-if="!detail" v-loading="searching" class="candidate-area">
			<template v-if="candidates.length">
				<div v-for="c in candidates" :key="c.id" class="candidate-card" @click="pick(c)">
					<el-image v-if="c.cover" class="candidate-cover" :src="c.cover" fit="cover" lazy>
						<template #error>
							<div class="candidate-cover-fallback">无图</div>
						</template>
					</el-image>
					<div v-else class="candidate-cover candidate-cover-fallback">无图</div>
					<div class="candidate-info">
						<div class="candidate-title">{{ c.title }}</div>
						<div class="candidate-meta">
							{{ c.year || "年份未知" }} · {{ c.eps > 0 ? `${c.eps} 集` : "集数未知" }}
							<template v-if="c.bangumiScore"> · ★ {{ c.bangumiScore }}</template>
						</div>
						<div class="candidate-summary">{{ c.summary.slice(0, 80) }}{{ c.summary.length > 80 ? "…" : "" }}</div>
					</div>
				</div>
			</template>
			<el-empty v-else-if="searched" description="没有找到相关番剧，换个关键词试试" :image-size="72" />
			<el-empty v-else description="输入番剧名称，从 Bangumi 检索条目信息（无需配置 AI）" :image-size="72" />
		</div>

		<!-- 详情确认 -->
		<div v-else v-loading="detailLoading" class="detail-area">
			<div class="detail-main">
				<el-image
					v-if="coverSrc"
					class="detail-cover"
					:src="coverSrc"
					fit="cover"
					lazy
					preview-teleported
					:preview-src-list="[coverSrc]"
				/>
				<div v-else class="detail-cover detail-cover-fallback">无封面</div>
				<div class="detail-info">
					<div class="detail-title">
						{{ detail.title }}
						<span v-if="detail.originalTitle && detail.originalTitle !== detail.title" class="detail-original">
							{{ detail.originalTitle }}
						</span>
					</div>
					<div class="detail-line">
						{{ detail.year || "年份未知" }} · {{ detail.eps > 0 ? `${detail.eps} 集` : "集数未知" }}
						<template v-if="detail.bangumiScore"> · ★ {{ detail.bangumiScore }}</template>
						<template v-if="detail.studio"> · {{ detail.studio }}</template>
					</div>
					<div v-if="periodText" class="detail-line">放送：{{ periodText }}</div>
					<div v-if="detail.genres.length" class="detail-tags">
						<el-tag v-for="g in detail.genres" :key="g" size="small" disable-transitions>{{ g }}</el-tag>
					</div>
					<div class="detail-summary">{{ detail.summary || "（无简介）" }}</div>
					<div class="detail-src">
						数据来源：<el-link :href="detail.link" target="_blank" type="primary">
							bgm.tv/subject/{{ detail.id }}
						</el-link>
					</div>
				</div>
			</div>
			<div class="detail-status">
				<el-tag v-if="coverResult" type="success" size="small" disable-transitions>
					封面已入库 {{ coverResult.fileName }}
				</el-tag>
				<el-tag v-else-if="coverFailed" type="warning" size="small" disable-transitions>
					封面下载失败，可稍后在编辑弹窗手动上传
				</el-tag>
				<el-checkbox v-if="aiEnabled" v-model="aiPolish">AI润色简介与类型</el-checkbox>
			</div>
		</div>

		<template #footer>
			<template v-if="detail">
				<el-button @click="detail = null">返回列表</el-button>
				<el-button type="primary" :loading="applying" :disabled="detailLoading" @click="confirmApply">
					填入新建番剧
				</el-button>
			</template>
			<el-button v-else @click="visible = false">关闭</el-button>
		</template>
	</el-dialog>
</template>

<style scoped>
	.search-bar {
		display: flex;
		gap: 10px;
		margin-bottom: 14px;
	}
	.candidate-area {
		min-height: 280px;
		max-height: 56vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.candidate-card {
		display: flex;
		gap: 12px;
		padding: 10px;
		border: 1px solid var(--hairline);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.45);
		cursor: pointer;
		transition: border-color 0.2s ease, box-shadow 0.2s ease;
	}
	.candidate-card:hover {
		border-color: var(--accent-a);
		box-shadow: 0 4px 16px rgba(99, 102, 241, 0.15);
	}
	.candidate-cover,
	.candidate-cover-fallback {
		width: 52px;
		height: 72px;
		flex: none;
		border-radius: 8px;
		overflow: hidden;
	}
	.candidate-cover-fallback,
	.detail-cover-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.14);
		color: var(--text-sub, #909399);
		font-size: 20px;
	}
	.candidate-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.candidate-title {
		font-weight: 600;
		font-size: 20px;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.candidate-meta {
		font-size: 20px;
		color: var(--text-sub);
	}
	.candidate-summary {
		font-size: 20px;
		color: var(--text-sub);
		line-height: 1.5;
	}
	.detail-area {
		min-height: 300px;
	}
	.detail-main {
		display: flex;
		gap: 18px;
	}
	.detail-cover,
	.detail-cover-fallback {
		width: 150px;
		height: 210px;
		flex: none;
		border-radius: 12px;
		overflow: hidden;
	}
	.detail-info {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.detail-title {
		font-size: 20px;
		font-weight: 700;
		line-height: 1.4;
	}
	.detail-original {
		font-size: 20px;
		font-weight: 400;
		color: var(--text-sub);
		margin-left: 6px;
	}
	.detail-line {
		font-size: 20px;
		color: var(--text-sub);
	}
	.detail-tags {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.detail-summary {
		font-size: 20px;
		line-height: 1.7;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 150px;
		overflow-y: auto;
	}
	.detail-src {
		font-size: 20px;
		color: var(--text-sub);
	}
	.detail-status {
		display: flex;
		align-items: center;
		gap: 12px;
		margin-top: 14px;
		padding-top: 10px;
		border-top: 1px dashed var(--hairline);
	}
</style>
