<script setup lang="ts">
	import { computed, onMounted, ref } from "vue";
	import { useRouter } from "vue-router";
	import { momentApi, postApi } from "../api";
	import type { MomentMeta, PostMeta } from "@shirone-admin/shared";
	import { useSystemStore } from "../stores/system";
	import PreviewPanel from "../components/PreviewPanel.vue";

	const router = useRouter();
	const sys = useSystemStore();
	const posts = ref<PostMeta[]>([]);
	const moments = ref<MomentMeta[]>([]);

	const changeCount = ref(0);

	/** 文章 + 说说中标记为草稿的数量 */
	const draftCount = computed(
		() => posts.value.filter((p) => p.draft).length + moments.value.filter((m) => m.draft).length,
	);

	onMounted(async () => {
		await sys.refresh().catch(() => {});
		if (sys.status?.contentConnected) {
			posts.value = await postApi.list().catch(() => []);
			moments.value = await momentApi.list().catch(() => []);
			changeCount.value =
				(sys.status.git?.staged.length ?? 0) +
				(sys.status.git?.modified.length ?? 0) +
				(sys.status.git?.untracked.length ?? 0);
		}
	});
</script>

<template>
	<div>
		<el-row :gutter="14">
			<el-col :span="6">
				<el-card shadow="never">
					<el-statistic title="待发布变更" :value="changeCount" />
					<el-button size="small" type="primary" style="margin-top: 10px" @click="router.push('/publish')">
						去发布
					</el-button>
				</el-card>
			</el-col>
			<el-col :span="6">
				<el-card shadow="never">
					<el-statistic title="文章总数" :value="posts.length" />
					<el-button size="small" style="margin-top: 10px" @click="router.push('/posts')">管理文章</el-button>
				</el-card>
			</el-col>
			<el-col :span="6">
				<el-card shadow="never">
					<el-statistic title="动态总数" :value="moments.length" />
					<el-button size="small" style="margin-top: 10px" @click="router.push('/moments')">管理说说</el-button>
				</el-card>
			</el-col>
			<el-col :span="6">
				<el-card shadow="never">
					<el-statistic title="草稿总数" :value="draftCount" />
					<el-button size="small" style="margin-top: 10px" @click="router.push('/posts')">继续创作</el-button>
				</el-card>
			</el-col>
		</el-row>

		<el-row :gutter="14" class="bottom-row" style="margin-top: 14px">
			<el-col :span="12">
				<el-card shadow="never">
					<template #header>
						<div class="card-head">
							<span>最近文章</span>
							<el-link type="primary" :underline="false" @click="router.push('/posts')">更多</el-link>
						</div>
					</template>
					<el-empty v-if="posts.length === 0" description="还没有文章，点「管理文章」新建第一篇" />
					<ul v-else class="recent">
						<li v-for="p in posts.slice(0, 6)" :key="p.path">
							<el-tag v-if="p.draft" size="small" type="warning">草稿</el-tag>
							{{ p.title }}
							<span class="muted">{{ p.published }}</span>
						</li>
					</ul>
				</el-card>
			</el-col>
			<el-col :span="12">
				<el-card shadow="never">
					<template #header>
						<div class="card-head">
							<span>最近动态</span>
							<el-link type="primary" :underline="false" @click="router.push('/moments')">更多</el-link>
						</div>
					</template>
					<el-empty v-if="moments.length === 0" description="还没有说说，去「说说动态」发一条" />
					<ul v-else class="recent">
						<li v-for="m in moments.slice(0, 6)" :key="m.path">
							<div class="moment-head">
								<el-tag v-if="m.pinned" size="small">置顶</el-tag>
								<el-tag v-if="m.draft" size="small" type="warning">草稿</el-tag>
								<el-tag v-for="t in m.tags.slice(0, 3)" :key="t" size="small" type="info">{{ t }}</el-tag>
								<span class="muted">{{ m.published }}</span>
							</div>
							<div class="clamp pre-wrap">{{ m.body }}</div>
							<div v-if="m.images.length" class="thumbs">
								<el-image
									v-for="img in m.images.slice(0, 3)"
									:key="img.src"
									:src="img.src"
									fit="cover"
									:preview-src-list="m.images.map((i) => i.src)"
									preview-teleported
								/>
							</div>
						</li>
					</ul>
				</el-card>
			</el-col>
		</el-row>

		<el-card shadow="never" style="margin-top: 14px" :body-style="{ padding: 0 }">
			<PreviewPanel title="真站预览" frame-height="clamp(320px, calc(100vh - 530px), 900px)" />
		</el-card>
	</div>
</template>

<style scoped>
	/* 四张统计卡片等高：任一被撑高时整行跟随 */
	.el-col {
		display: flex;
	}

	.el-col > .el-card {
		flex: 1;
		width: 100%;
	}

	.moment-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}

	.clamp {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
		line-height: 1.5;
		margin-top: 3px;
	}

	.thumbs {
		display: flex;
		gap: 6px;
		margin-top: 6px;
	}

	.thumbs .el-image {
		width: 52px;
		height: 52px;
		border-radius: 6px;
	}

	.recent {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.recent li {
		padding: 7px 0;
		border-bottom: 1px dashed var(--el-border-color-lighter);
	}
	.recent li:last-child {
		border-bottom: none;
	}
	.muted {
		color: var(--el-text-color-secondary);
		font-size: 20px;
		margin-left: 8px;
	}
</style>
