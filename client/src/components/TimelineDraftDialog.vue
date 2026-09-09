<script setup lang="ts">
	import { computed, ref, watch } from "vue";
	import { ElMessage } from "element-plus";
	import { Icon } from "@iconify/vue";
	import { aiApi } from "../api";
	import type { TimelineDraftPayload } from "../types/imports";

	/**
	 * 时间线 AI 起草：从提交历史（默认，扫描内容 / 主题 / Admin 三仓）或用户描述生成，
	 * 打开后手动点「生成草稿」；卡片可勾选多条、按日期排序、就地编辑，
	 * 批量 emit 后由 DataView 按日期插入本地列表。
	 */
	const visible = defineModel<boolean>({ default: false });
	const emit = defineEmits<{ apply: [payloads: TimelineDraftPayload[]] }>();
	/** 已收录的时间线事件，git 扫描时送服务端去重：已有的不再推荐 */
	const props = defineProps<{ existing?: Array<{ title: string; date: string }> }>();

	const CATEGORY_OPTIONS = [
		{ value: "milestone", label: "里程碑" },
		{ value: "project", label: "项目" },
		{ value: "career", label: "经历" },
		{ value: "life", label: "生活" },
	];

	/** 卡片 = 草稿数据 + 勾选/编辑状态；排序、增删不会让选中错位 */
	interface DraftCard {
		data: TimelineDraftPayload;
		checked: boolean;
		editing: boolean;
	}

	const mode = ref<"note" | "git">("git");
	const note = ref("");
	const generating = ref(false);
	const generated = ref(false);
	const cards = ref<DraftCard[]>([]);

	/** 生成请求序号：关闭弹窗时递增，令在途请求的结果作废 */
	let genSeq = 0;

	const pickedCount = computed(() => cards.value.filter((c) => c.checked).length);

	async function generate(): Promise<void> {
		if (generating.value) return;
		if (mode.value === "note" && note.value.trim() === "") {
			ElMessage.warning("先描述事件，如：2026-03 博客主题升级到 Material 3");
			return;
		}
		const seq = ++genSeq;
		generating.value = true;
		try {
			const r =
				mode.value === "note"
					? await aiApi.timelineDraft({ mode: "note", note: note.value.trim(), limit: 1 })
					: await aiApi.timelineDraft({ mode: "git", limit: 5, existing: props.existing });
			if (seq !== genSeq) return;
			cards.value = r.events.map((data) => ({ data, checked: true, editing: false }));
			generated.value = true;
			sortCards();
			if (r.events.length === 0) {
				ElMessage.info(
					mode.value === "note"
						? "没有产出可用草稿，换个描述试试"
						: r.duplicated > 0
							? "扫描到的节点都已收录，无新增"
							: "提交历史里没识别出里程碑节点",
				);
			}
		} catch (e) {
			if (seq !== genSeq) return;
			ElMessage.error((e as Error).message);
		} finally {
			if (seq === genSeq) generating.value = false;
		}
	}

	/** 关闭即清空：下次打开是全新草稿态，残留的在途请求也一并作废 */
	watch(visible, (v) => {
		if (v) return;
		genSeq++;
		cards.value = [];
		generated.value = false;
		note.value = "";
		mode.value = "git";
		generating.value = false;
	});

	/** 按日期新在前排序；缺日期的垫底待补 */
	function sortCards(): void {
		cards.value.sort((a, b) => dateValue(b.data.date) - dateValue(a.data.date));
	}

	function dateValue(date: string): number {
		return /^\d{4}-\d{2}-\d{2}$/.test(date) ? Number(date.replace(/-/g, "")) : -1;
	}

	/** 收起编辑即重排：改了日期的卡片回到时间序位置（编辑中不挪动防跳） */
	function toggleEdit(card: DraftCard): void {
		card.editing = !card.editing;
		if (!card.editing) sortCards();
	}

	function applyPicked(): void {
		const picked = cards.value.filter((c) => c.checked);
		if (picked.length === 0) {
			ElMessage.warning("先勾选要采用的草稿");
			return;
		}
		if (picked.some((c) => c.data.title.trim() === "")) {
			ElMessage.warning("有条目标题为空，编辑补全后再选用");
			return;
		}
		if (picked.some((c) => c.data.date === "")) {
			ElMessage.warning("有条目缺日期，编辑补全后再选用");
			return;
		}
		emit(
			"apply",
			picked.map((c) => c.data),
		);
		visible.value = false;
	}

	function categoryLabel(key: string): string {
		return CATEGORY_OPTIONS.find((o) => o.value === key)?.label ?? key;
	}
</script>

<template>
	<el-dialog v-model="visible" title="AI 起草时间线事件" width="920px" align-center class="tl-draft-dialog">
		<el-radio-group v-model="mode">
			<el-radio-button value="git">从提交历史</el-radio-button>
			<el-radio-button value="note">描述生成</el-radio-button>
		</el-radio-group>

		<div class="mode-panel">
			<div class="note-box" :class="{ ghost: mode !== 'note' }">
				<el-input
					v-model="note"
					type="textarea"
					:rows="3"
					maxlength="500"
					show-word-limit
					placeholder="一句话描述事件，如：2026-03 博客主题升级到 Material 3，全面改版视觉"
				/>
			</div>
			<div class="git-tip" :class="{ ghost: mode !== 'git' }">扫描三仓提交记录，AI 归并里程碑节点，日期取真实提交日（精确到日）。</div>
		</div>

		<el-button type="primary" class="gen-btn" :loading="generating" :disabled="generating" @click="generate">
			<el-icon v-if="!generating"><Icon icon="material-symbols:auto-awesome" /></el-icon>
			{{ mode === "git" && cards.length > 0 ? "重新扫描" : "生成草稿" }}
		</el-button>

		<div v-if="generating" class="loading-tip" v-loading="true" element-loading-text="正在生成草稿…">　</div>
		<div v-else-if="generated && cards.length === 0" class="empty-tip">没有可用草稿，可重试或换个方式</div>
		<div v-else class="cards">
			<div v-for="(c, i) in cards" :key="i" class="card" :class="{ unchecked: !c.checked }">
				<div class="card-head">
					<template v-if="!c.editing">
						<span class="card-title">{{ c.data.title }}</span>
						<el-tag>{{ categoryLabel(c.data.category) }}</el-tag>
						<el-tag v-if="c.data.date" effect="plain">{{ c.data.date }}</el-tag>
						<el-tag v-else type="danger">缺日期</el-tag>
					</template>
					<template v-else>
						<span class="flabel">标题</span>
						<el-input v-model="c.data.title" class="col-grow" />
					</template>
					<div class="grow"></div>
					<el-button @click="toggleEdit(c)">{{ c.editing ? "收起" : "编辑" }}</el-button>
				</div>

				<template v-if="!c.editing">
					<div v-if="c.data.subtitle" class="card-sub">{{ c.data.subtitle }}</div>
					<p v-if="c.data.description" class="card-desc">{{ c.data.description }}</p>
					<ul v-if="c.data.highlights.length" class="card-points">
						<li v-for="(h, j) in c.data.highlights" :key="j">{{ h }}</li>
					</ul>
					<div v-if="c.data.tags.length" class="card-foot">
						<el-tag v-for="t in c.data.tags" :key="t" effect="plain">{{ t }}</el-tag>
					</div>
				</template>

				<div v-else class="edit-form">
					<div class="row">
						<span class="flabel">副标题</span>
						<el-input v-model="c.data.subtitle" class="col-grow" placeholder="可选" />
					</div>
					<div class="row">
						<span class="flabel">时间</span>
						<el-date-picker
							v-model="c.data.date"
							type="date"
							format="YYYY-MM-DD"
							value-format="YYYY-MM-DD"
							placeholder="精确到日"
							class="date-picker"
						/>
						<span class="flabel">分类</span>
						<el-select v-model="c.data.category" class="cat-select">
							<el-option v-for="o in CATEGORY_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
						</el-select>
					</div>
					<div class="row">
						<span class="flabel">描述</span>
						<el-input v-model="c.data.description" type="textarea" :rows="2" class="col-grow" placeholder="可选" />
					</div>
					<div class="row">
						<span class="flabel">要点</span>
						<el-select
							class="col-grow"
							:model-value="c.data.highlights"
							multiple
							filterable
							allow-create
							default-first-option
							tag-type="primary"
							placeholder="回车添加，可选"
							@update:model-value="(v: unknown) => (c.data.highlights = v as string[])"
						/>
						<span class="flabel">标签</span>
						<el-select
							class="col-grow"
							:model-value="c.data.tags"
							multiple
							filterable
							allow-create
							default-first-option
							tag-type="primary"
							placeholder="回车添加，可选"
							@update:model-value="(v: unknown) => (c.data.tags = v as string[])"
						/>
					</div>
				</div>
				<el-checkbox v-model="c.checked" class="card-check" />
			</div>
		</div>

		<template #footer>
			<div class="footer-bar">
				<span class="picked-count">已选 {{ pickedCount }} / {{ cards.length }} 条</span>
				<el-button type="primary" :disabled="pickedCount === 0" @click="applyPicked">
					选用 {{ pickedCount }} 条
				</el-button>
			</div>
		</template>
	</el-dialog>
</template>

<style scoped>
	/* 两模式内容叠同一格、只隐藏不移除，高度恒等于较高者（描述文本域），切 tab 不跳 */
	.mode-panel {
		margin-top: 12px;
		display: grid;
	}
	.mode-panel > * {
		grid-area: 1 / 1;
	}
	.mode-panel > .ghost {
		visibility: hidden;
	}
	.git-tip {
		font-size: 20px;
		color: var(--el-text-color-regular);
	}
	.gen-btn {
		margin-top: 10px;
		align-self: center;
	}
	.loading-tip {
		margin-top: 14px;
		flex: 1;
	}
	.empty-tip {
		margin-top: 14px;
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}
	.cards {
		margin-top: 14px;
		display: flex;
		flex-direction: column;
		gap: 12px;
		/* 弹窗定高：列表占满剩余空间，只在自身内部滚动 */
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.card {
		position: relative;
		background: var(--el-fill-color-light);
		border: 1px solid var(--el-border-color-light);
		border-radius: 8px;
		padding: 12px 14px;
		/* 右侧给大号勾选框留位 */
		padding-right: 60px;
	}
	/* 勾选框：右侧垂直居中、放大到 26px，对勾同比放大 */
	.card-check {
		position: absolute;
		top: 50%;
		right: 16px;
		transform: translateY(-50%);
		height: auto;
		--el-checkbox-input-width: 26px;
		--el-checkbox-input-height: 26px;
		--el-checkbox-border-radius: 6px;
	}
	.card-check :deep(.el-checkbox__inner::after) {
		width: 6px;
		height: 13px;
		border-width: 0 2px 2px 0;
	}
	.card.unchecked {
		opacity: 0.6;
	}
	.card-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.card-title {
		font-weight: 600;
		font-size: 22px;
	}
	/* 胶囊放大提亮：头部分类/日期与底部标签统一 18px / 32px 高 */
	.card-head .el-tag,
	.card-foot .el-tag {
		font-size: 18px;
		height: 32px;
		line-height: 30px;
		padding: 0 14px;
	}
	.card-sub {
		margin-top: 4px;
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}
	.card-desc {
		margin: 6px 0 0;
		font-size: 20px;
		line-height: 1.6;
	}
	.card-points {
		margin: 6px 0 0;
		padding-left: 18px;
		font-size: 20px;
		color: var(--el-text-color-regular);
	}
	.card-foot {
		margin-top: 8px;
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}
	.grow {
		flex: 1;
	}
	.edit-form {
		margin-top: 8px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.edit-form .row {
		display: flex;
		gap: 8px;
	}
	/* el-select / el-date-picker 默认不占满，需显式定宽，否则行内塌陷错乱 */
	.col-grow {
		flex: 1;
		min-width: 0;
	}
	.date-picker {
		width: 230px;
		flex-shrink: 0;
	}
	.cat-select {
		width: 190px;
		flex-shrink: 0;
	}
	/* 表单字段名：定宽两端对齐，两字/三字名称左缘整齐 */
	.flabel {
		flex: none;
		width: 64px;
		font-size: 20px;
		color: var(--el-text-color-regular);
		text-align: justify;
		text-align-last: justify;
	}
	.footer-bar {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 14px;
	}
	.picked-count {
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}
</style>

<style>
	/* 弹窗定高（不随卡片数量撑开）：header / footer 固定，body 弹性填充 */
	.tl-draft-dialog {
		height: 86vh;
		display: flex;
		flex-direction: column;
	}
	/* EP 的 align-center 只写 margin:auto，块级布局竖直方向不生效；弹层改 flex 后才真正垂直居中 */
	.el-overlay-dialog:has(.tl-draft-dialog) {
		display: flex;
		justify-content: center;
		align-items: flex-start;
	}
	.tl-draft-dialog .el-dialog__body {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
	}
</style>
