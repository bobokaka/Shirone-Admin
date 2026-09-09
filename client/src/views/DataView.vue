<script setup lang="ts">
	import { computed, onMounted, reactive, ref, shallowRef } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { DataItem, DataKind } from "@shirone-admin/shared";
	import { aiApi, dataApi, mediaApi } from "../api";
	import { useAiConsoleStore } from "../stores/aiConsole";
	import AnimeImportDialog from "../components/AnimeImportDialog.vue";
	import DataIcon from "../components/DataIcon.vue";
	import DateField from "../components/DateField.vue";
	import EntryListEditor from "../components/EntryListEditor.vue";
	import IconInput from "../components/IconInput.vue";
	import MusicImportDialog from "../components/MusicImportDialog.vue";
	import MusicPlayerBar from "../components/MusicPlayerBar.vue";
	import TimelineDraftDialog from "../components/TimelineDraftDialog.vue";
	import {
		DATA_DESCRIPTORS,
		descriptorOf,
		tableFields,
		type DataFieldDescriptor,
		type EntryDraft,
	} from "../descriptors/dataFields";
	import { contentPreviewUrl } from "../utils/assets";
	import { formatDuration } from "../utils/format";
	import { slugifyText } from "../utils/slugify";
	import type { AnimeImportPayload, MusicImportPayload, TimelineDraftPayload } from "../types/imports";

	const activeKind = ref<DataKind>("projects");
	const itemsByKind = reactive<Record<string, DataItem[]>>({});
	const loadingByKind = reactive<Record<string, boolean>>({});

	const desc = computed(() => descriptorOf(activeKind.value));
	const items = computed(() => itemsByKind[activeKind.value] ?? []);
	/** 标题字段 key（表格标题列与图标首字母兜底用） */
	const titleKey = computed(() => desc.value.titleKey ?? desc.value.fields[0].key);
	/** 编辑弹窗字段：标识类（autoKey/autoId）不在表单出现 */
	const formFields = computed(() => desc.value.fields.filter((f) => !f.autoKey && !f.autoId));
	/** 图片字段单独渲染为表格首列缩略图（type === "image"） */
	const coverField = computed(() => desc.value.fields.find((f) => f.type === "image"));
	/** 头像字段（type === "avatar"）：表格额外渲染一个方形头像列，URL 文本列保留 */
	const avatarField = computed(() => desc.value.fields.find((f) => f.type === "avatar"));
	const columns = computed(() => tableFields(desc.value).filter((f) => f.type !== "image"));
	const loaded = (kind: DataKind) => itemsByKind[kind] !== undefined;

	async function load(kind: DataKind, force = false): Promise<void> {
		if (!force && loaded(kind)) return;
		loadingByKind[kind] = true;
		try {
			const r = await dataApi.get(kind);
			itemsByKind[kind] = r.items;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loadingByKind[kind] = false;
		}
	}

	function switchKind(kind: DataKind): void {
		activeKind.value = kind;
		load(kind).catch((e: Error) => ElMessage.error(e.message));
	}

	/** 改动即落仓：串行队列避免并发写回乱序，快照防止排队期间切页写错 kind */
	let saveQueue: Promise<void> = Promise.resolve();
	function persist(): void {
		const kind = activeKind.value;
		const snapshot = [...items.value];
		saveQueue = saveQueue.then(async () => {
			try {
				await dataApi.save(kind, snapshot);
				ElMessage.success("已保存");
			} catch (e) {
				ElMessage.error((e as Error).message);
			}
		});
	}

	/* ---------- 编辑弹窗 ---------- */

	const dialogVisible = ref(false);
	const editIndex = ref(-1);
	const form = ref<DataItem>({});
	/** JSON 字段以文本暂存，确认时解析回对象 */
	const jsonDrafts = reactive<Record<string, string>>({});
	/** 条目列表可视化草稿（罗盘导航/时间线链接，编辑时克隆，确认时清洗写回） */
	const entriesDraft = ref<EntryDraft[]>([]);

	function defaultOf(f: DataFieldDescriptor): unknown {
		switch (f.type) {
			case "number":
				return 0;
			case "boolean":
				return false;
			case "string[]":
				return [];
			case "json":
				return null;
			case "progress":
				return { watched: 0, total: 0 };
			case "entries":
				return [];
			case "date":
				return "";
			case "icon":
			default:
				return "";
		}
	}

	function openCreate(): void {
		const d = desc.value;
		const item: DataItem = {};
		for (const f of d.fields) {
			item[f.key] = f.autoId ? nextAutoId(f.key) : defaultOf(f);
		}
		startEdit(item, -1);
	}

	function nextAutoId(key: string): number {
		const ids = items.value.map((x) => Number(x[key]) || 0);
		return ids.length ? Math.max(...ids) + 1 : 1;
	}

	/* ---------- 进度字段（总集数下拉 + 10% 档滑块）---------- */

	/** 常见动画总集数档位（下拉可选，支持输入自定义值） */
	const PROGRESS_TOTALS = [
		5, 12, 13, 24, 25, 26, 36, 39, 49, 50, 51, 52, 64, 69, 70, 101, 110, 128, 153, 167, 172,
		178, 220, 300, 500, 1000, 1100, 1200, 1500, 1787, 3000,
	];

	const progressDraft = reactive({ total: 0, percent: 0 });

	const progressTotal = computed({
		get: () => progressDraft.total,
		set: (v: number | string) => {
			progressDraft.total = Math.max(0, Math.round(Number(v) || 0));
		},
	});

	const progressWatched = computed(() =>
		Math.round((progressDraft.total * progressDraft.percent) / 100),
	);

	function pctTooltip(v: number): string {
		return `${v}%`;
	}

	function syncProgressDraft(item: DataItem): void {
		const p = (item.progress ?? {}) as { watched?: unknown; total?: unknown };
		const total = Math.round(Number(p.total) || 0);
		const watched = Math.round(Number(p.watched) || 0);
		progressDraft.total = total;
		// 既有精确进度吸附到最近的 10% 档
		progressDraft.percent =
			total > 0 ? Math.min(100, Math.max(0, Math.round((watched / total) * 10) * 10)) : 0;
	}

	/** 条目列表原始值 → 可视化草稿（浅克隆防误改表格行；未知键随展开保留） */
	function normalizeEntries(v: unknown, keys: string[]): EntryDraft[] {
		if (!Array.isArray(v)) return [];
		return v.map((e) => {
			const o = (e ?? {}) as Record<string, unknown>;
			const draft: EntryDraft = { ...o };
			for (const k of keys) draft[k] = typeof o[k] === "string" ? o[k] : "";
			return draft;
		});
	}

	function startEdit(item: DataItem, index: number): void {
		editIndex.value = index;
		form.value = { ...item };
		for (const f of desc.value.fields) {
			if (f.type === "json") {
				jsonDrafts[f.key] = JSON.stringify(item[f.key] ?? null, null, 2);
			} else if (f.type === "entries") {
				entriesDraft.value = normalizeEntries(
					item[f.key],
					(f.itemFields ?? []).map((s) => s.key),
				);
			}
		}
		syncProgressDraft(item);
		dialogVisible.value = true;
	}

	function editRow(index: number): void {
		startEdit(items.value[index], index);
	}

	function confirmEdit(): void {
		const d = desc.value;
		const item: DataItem = { ...form.value };
		for (const f of d.fields) {
			if (f.type === "progress") {
				item[f.key] = {
					watched: progressDraft.total > 0 ? progressWatched.value : 0,
					total: progressDraft.total,
				};
				continue;
			}
			if (f.type === "image") {
				// 清除封面 → 整个字段不写入，而不是留空字符串
				if (String(item[f.key] ?? "").trim() === "") delete item[f.key];
				continue;
			}
			if (f.type === "entries") {
				const subs = f.itemFields ?? [];
				const required = subs.filter((s) => s.required);
				const cleaned: Array<Record<string, unknown>> = [];
				for (let i = 0; i < entriesDraft.value.length; i++) {
					const e = entriesDraft.value[i];
					const vals: Record<string, string> = {};
					for (const s of subs) vals[s.key] = String(e[s.key] ?? "").trim();
					// 子字段全空视为误加的空行，静默丢弃；必填缺失则拦下提醒
					if (subs.every((s) => vals[s.key] === "")) continue;
					const missing = required.find((s) => vals[s.key] === "");
					if (missing) {
						ElMessage.warning(`「${f.label}」第 ${i + 1} 条的「${missing.label}」未填`);
						return;
					}
					// 展开保留未知键（如 image），仅规整配置的子字段
					const out: Record<string, unknown> = { ...e };
					for (const s of subs) out[s.key] = vals[s.key];
					for (const s of subs) {
						if (!s.required && vals[s.key] === "") delete out[s.key];
					}
					cleaned.push(out);
				}
				item[f.key] = cleaned;
				continue;
			}
			// 标识类字段：编辑保留原值；新增（或值缺失）由标题生成拼音 slug，重名加序号
			if (f.autoKey) {
				const existing = String(item[f.key] ?? "").trim();
				if (existing && editIndex.value >= 0) {
					item[f.key] = existing;
					continue;
				}
				const base = slugifyText(String(item[titleKey.value] ?? ""));
				let candidate = base;
				let n = 2;
				while (items.value.some((x) => String(x[f.key]) === candidate)) candidate = `${base}-${n++}`;
				item[f.key] = candidate;
				continue;
			}
			// 分类等键值字段：直接输入了中文 label 时反查回 key，保证入库值不变
			if (f.type === "text" && f.displayMap) {
				const raw = String(item[f.key] ?? "").trim();
				const key =
					raw && !(raw in f.displayMap)
						? (Object.entries(f.displayMap).find(([, label]) => label === raw)?.[0] ?? raw)
						: raw;
				item[f.key] = key;
			}
			if (f.required) {
				const v = item[f.key];
				if (v === undefined || v === "" || v === null) {
					ElMessage.warning(`「${f.label}」不能为空`);
					return;
				}
			}
			if (f.type === "json") {
				const draft = (jsonDrafts[f.key] ?? "").trim();
				if (draft === "") {
					delete item[f.key];
					continue;
				}
				try {
					item[f.key] = JSON.parse(draft);
				} catch {
					ElMessage.warning(`「${f.label}」不是合法 JSON`);
					return;
				}
			}
			if (f.type === "string[]") {
				item[f.key] = Array.isArray(item[f.key]) ? item[f.key] : [];
			}
		}
		if (editIndex.value >= 0) items.value.splice(editIndex.value, 1, item);
		else items.value.push(item);
		persist();
		dialogVisible.value = false;
	}

	async function removeRow(index: number): Promise<void> {
		const label = String(items.value[index][desc.value.titleKey ?? desc.value.fields[0].key] ?? "");
		await ElMessageBox.confirm(`删除「${label}」？`, "删除条目", {
			type: "warning",
			confirmButtonText: "删除",
			cancelButtonText: "取消",
		});
		items.value.splice(index, 1);
		persist();
	}

	function move(index: number, delta: number): void {
		const j = index + delta;
		if (j < 0 || j >= items.value.length) return;
		[items.value[index], items.value[j]] = [items.value[j], items.value[index]];
		persist();
	}

	/** 表格内直接切换布尔字段（如项目精选）：改完即落仓 */
	function toggleBool(row: DataItem, key: string, v: string | number | boolean): void {
		row[key] = Boolean(v);
		persist();
	}

	function cellText(item: DataItem, f: DataFieldDescriptor): string {
		const v = item[f.key];
		if (v === undefined || v === null || v === "") return "—";
		// 分类等键值字段按 displayMap 显示中文，未知值原样显示
		if (f.displayMap && typeof v === "string") return f.displayMap[v] ?? v;
		if (f.type === "progress") {
			const p = v as { watched?: number; total?: number };
			if (!p.total) return "—";
			return `${p.watched ?? 0} / ${p.total}`;
		}
		if (f.key === "duration") return formatDuration(Number(v));
		if (f.type === "enum") return f.enumValues?.find((o) => o.value === v)?.label ?? String(v);
		if (f.type === "boolean") return v ? "是" : "否";
		if (f.type === "string[]" && Array.isArray(v)) return v.join("、");
		if (f.type === "json") return JSON.stringify(v);
		return String(v);
	}

	/** 表格内条目列表解析视图（罗盘导航条目）：非数组容错为空 */
	function entryListOf(row: DataItem, key: string): EntryDraft[] {
		return Array.isArray(row[key]) ? normalizeEntries(row[key], []) : [];
	}

	function entryTooltip(e: EntryDraft): string {
		const note = String(e.note ?? "").trim();
		const href = String(e.href ?? "");
		return note ? `${note} · ${href}` : href;
	}

	/* ---------- 图片字段（封面缩略图与上传替换）---------- */

	/** string[] 字段候选建议：聚合当前类型全部条目出现过的值，按频次排序 */
	function suggestionsOf(key: string): string[] {
		const counter = new Map<string, number>();
		for (const item of items.value) {
			const v = item[key];
			if (!Array.isArray(v)) continue;
			for (const tag of v) {
				const s = typeof tag === "string" ? tag.trim() : "";
				if (s !== "") counter.set(s, (counter.get(s) ?? 0) + 1);
			}
		}
		return [...counter.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
			.map(([tag]) => tag);
	}

	const uploadingField = ref("");

	async function uploadCover(key: string, file: File): Promise<void> {
		uploadingField.value = key;
		try {
			const r = await mediaApi.dataCover(activeKind.value, String(form.value[key] ?? ""), file);
			form.value[key] = r.src;
			ElMessage.success(`已上传 ${r.fileName}`);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			uploadingField.value = "";
		}
	}

	/** el-upload 的 http-request 适配（模板表达式里写不了带类型的箭头函数） */
	function coverUploadRequest(key: string): (options: { file: File }) => Promise<void> {
		return (options) => uploadCover(key, options.file);
	}

	/* ---------- 歌单试听（曲目与播放状态由 MusicPlayerBar 回传同步）---------- */

	const isMusic = computed(() => activeKind.value === "music");
	const playerBar = ref<InstanceType<typeof MusicPlayerBar>>();
	/** 当前试听曲目（编辑/重读后由播放条回传新引用，行高亮与图标始终对齐） */
	const playingTrack = shallowRef<DataItem | null>(null);
	const trackPlaying = ref(false);

	function toggleRowPlay(row: DataItem): void {
		if (playingTrack.value === row) playerBar.value?.togglePlay();
		else playingTrack.value = row;
	}

	function playingRowClass({ row }: { row: DataItem }): string {
		return playingTrack.value === row ? "music-playing-row" : "";
	}

	/* ---------- 编辑弹窗字段级 AI（描述类 textarea 的 ✨ 按钮，流式控制台执行）---------- */

	const aiConsole = useAiConsoleStore();
	const fieldAiRunning = computed(() => aiConsole.running);
	const fieldAiKey = ref("");

	/** 按条目标题组装指令：有内容改写、无内容生成，1-3 句中文 */
	async function runFieldAi(f: DataFieldDescriptor): Promise<void> {
		if (fieldAiRunning.value) return;
		const itemTitle = String(form.value[titleKey.value] ?? "").trim();
		if (itemTitle === "") {
			ElMessage.warning(`先填「${desc.value.fields.find((x) => x.key === titleKey.value)?.label ?? "标题"}」，AI 才有上下文`);
			return;
		}
		fieldAiKey.value = f.key;
		try {
			const current = String(form.value[f.key] ?? "").trim();
			const instruction =
				current === ""
					? `为${desc.value.itemLabel}「${itemTitle}」写一段「${f.label}」：1-3 句中文，客观具体，只输出内容本身。`
					: `改写以下${desc.value.itemLabel}「${itemTitle}」的「${f.label}」，信息不变、表达更流畅，1-3 句中文，只输出改写结果。`;
			// 流式回填：改写结果直接在字段里长出来；停止/失败恢复原值
			const result = await aiConsole.run(
				`AI改写·${f.label}`,
				{
					instruction,
					text: current === "" ? itemTitle : current,
					maxTokens: 2048,
				},
				{ onText: (full) => (form.value[f.key] = full) },
			);
			if (result === null) form.value[f.key] = current;
		} finally {
			fieldAiKey.value = "";
		}
	}

	/* ---------- 番剧搜索导入（Bangumi，AI 仅增强简介与类型）---------- */

	const aiEnabled = ref(false);
	const animeImportVisible = ref(false);

	/** 导入载荷 → 新建草稿并打开既有编辑弹窗；status/rating/watched 留给用户确认 */
	function applyBangumi(p: AnimeImportPayload): void {
		const item: DataItem = {
			title: p.title,
			year: p.year,
			status: "",
			rating: 0,
			progress: { watched: 0, total: p.eps },
			genres: p.genres,
			description: p.description,
		};
		if (p.cover) item.cover = p.cover;
		if (p.studio) item.studio = p.studio;
		if (p.link) item.link = p.link;
		if (p.period) item.period = p.period;
		startEdit(item, -1);
	}

	/* ---------- 音乐导入（直链/上传/AI 检索，音频封面均已落仓）---------- */

	const musicImportVisible = ref(false);

	/** 曲目 id 由 confirmEdit 的 autoKey 逻辑生成 */
	function applyMusicImport(p: MusicImportPayload): void {
		const item: DataItem = {
			id: "",
			title: p.title,
			source: p.source,
			duration: p.duration ?? 0,
		};
		if (p.artist) item.artist = p.artist;
		if (p.cover) item.cover = p.cover;
		startEdit(item, -1);
	}

	/* ---------- 时间线 AI 起草（描述 / git 历史 → 勾选多条 → 按日期插入）---------- */

	const timelineDraftVisible = ref(false);

	/** AI 起草去重用：当前时间线已收录事件（标题 + 日期原样送服务端比对） */
	const timelineExisting = computed(() =>
		(itemsByKind.timeline ?? []).map((it) => ({ title: String(it.title ?? ""), date: String(it.date ?? "") })),
	);

	/**
	 * 批量草稿 → 按日期插入列表（新在前，与内容仓时间线顺序一致），
	 * enable 直接开，插入后即落仓。
	 */
	function applyTimelineDrafts(list: TimelineDraftPayload[]): void {
		for (const p of list) {
			const item: DataItem = {
				title: p.title,
				// 弹窗已保证 YYYY-MM-DD 日精度；横线转点分与站点存储风格一致
				date: p.date.replace(/-/g, "."),
				category: p.category,
				description: p.description ?? "",
				highlights: p.highlights,
				tags: p.tags,
				enable: true,
			};
			if (p.subtitle) item.subtitle = p.subtitle;
			// 同为点分日格式，字典序即时间序：插到第一个更早的既有条目前
			const at = items.value.findIndex((x) => String(x.date ?? "") < String(item.date));
			if (at < 0) items.value.push(item);
			else items.value.splice(at, 0, item);
		}
		persist();
	}

	onMounted(() => {
		load("projects");
		// AI 是否启用只读一次：控制导入弹窗的润色开关与（阶段 5）字段级 AI 入口
		aiApi
			.getSettings()
			.then((s) => (aiEnabled.value = s.enable))
			.catch(() => {});
	});
</script>

<template>
	<div class="data-view">
		<el-card class="page-card">
			<el-tabs
				:model-value="activeKind"
				class="data-tabs"
				@tab-change="(name: string | number) => switchKind(name as DataKind)"
			>
				<el-tab-pane v-for="d in DATA_DESCRIPTORS" :key="d.kind" :label="d.label" :name="d.kind" />
			</el-tabs>

			<div class="page-toolbar">
				<el-button type="primary" @click="openCreate">
					<el-icon><Plus /></el-icon>新增{{ desc.itemLabel }}
				</el-button>
				<el-button v-if="activeKind === 'anime'" @click="animeImportVisible = true">
					<el-icon><Search /></el-icon>搜索导入
				</el-button>
				<el-button v-if="isMusic" @click="musicImportVisible = true">
					<el-icon><Download /></el-icon>导入音乐
				</el-button>
				<el-button v-if="activeKind === 'timeline' && aiEnabled" @click="timelineDraftVisible = true">
					<el-icon><Icon icon="material-symbols:auto-awesome" /></el-icon>AI起草
				</el-button>
				<div class="grow"></div>
				<el-tooltip content="重新读取" placement="top">
					<el-button circle :loading="loadingByKind[activeKind]" @click="load(activeKind, true)">
						<el-icon><Refresh /></el-icon>
					</el-button>
				</el-tooltip>
			</div>

			<div class="table-wrap">
				<el-table
					v-loading="loadingByKind[activeKind]"
					:data="items"
					height="100%"
					row-key="__i"
					:row-class-name="isMusic ? playingRowClass : undefined"
				>
					<el-table-column type="index" label="序号" width="80" />
					<el-table-column v-if="isMusic" label="播放" width="60" align="center">
						<template #default="{ row }">
							<el-button
								size="small"
								circle
								:type="playingTrack === row ? 'primary' : 'default'"
								:title="playingTrack === row && trackPlaying ? '暂停' : '试听'"
								@click="toggleRowPlay(row)"
							>
								<el-icon>
									<VideoPause v-if="playingTrack === row && trackPlaying" />
									<VideoPlay v-else />
								</el-icon>
							</el-button>
						</template>
					</el-table-column>
					<el-table-column v-if="coverField" :label="coverField.label" width="82">
						<template #default="{ row }">
							<el-image
								v-if="contentPreviewUrl(row[coverField.key])"
								class="cell-cover"
								:src="contentPreviewUrl(row[coverField.key])"
								:preview-src-list="[contentPreviewUrl(row[coverField.key])!]"
								fit="cover"
								lazy
								preview-teleported
							>
								<template #error>
									<div class="cell-cover-fallback"><el-icon><PictureFilled /></el-icon></div>
								</template>
							</el-image>
							<div v-else class="cell-cover-fallback"><el-icon><PictureFilled /></el-icon></div>
						</template>
					</el-table-column>
					<el-table-column v-if="avatarField" label="头像" width="72">
						<template #default="{ row }">
							<el-image
								v-if="contentPreviewUrl(row[avatarField.key])"
								class="cell-avatar"
								:src="contentPreviewUrl(row[avatarField.key])"
								:preview-src-list="[contentPreviewUrl(row[avatarField.key])!]"
								fit="cover"
								lazy
								preview-teleported
							>
								<template #error>
									<div class="cell-avatar-fallback"><el-icon><UserFilled /></el-icon></div>
								</template>
							</el-image>
							<div v-else class="cell-avatar-fallback"><el-icon><UserFilled /></el-icon></div>
						</template>
					</el-table-column>
					<el-table-column
						v-for="f in columns"
						:key="f.key"
						:label="f.label"
						:min-width="
							f.type === 'entries'
								? 320
								: f.type === 'icon'
									? 70
									: f.type === 'boolean'
										? 76
										: f.type === 'textarea'
											? 260
											: f.type === 'avatar'
												? 200
												: 130
						"
						:show-overflow-tooltip="f.type !== 'icon' && f.type !== 'entries'"
					>
						<template #default="{ row }">
							<div v-if="f.type === 'icon'" class="cell-icon">
								<el-tooltip
									:content="String(row[f.key] ?? '')"
									:disabled="String(row[f.key] ?? '').trim() === ''"
									placement="top"
								>
									<DataIcon
										:icon="(row[f.key] as string) ?? ''"
										:label="(row[titleKey] as string) ?? ''"
										:size="24"
									/>
								</el-tooltip>
							</div>
							<div v-else-if="f.type === 'entries'" class="cell-entries">
								<el-tooltip
									v-for="(e, i) in entryListOf(row, f.key)"
									:key="i"
									:content="entryTooltip(e)"
									placement="top"
								>
									<span class="entry-chip">
										<DataIcon
											:icon="(e.icon as string) ?? ''"
											:image="(e.image as string) ?? ''"
											:size="14"
											fallback="none"
										/>
										<span class="entry-chip__label">{{ e.label }}</span>
									</span>
								</el-tooltip>
								<span v-if="entryListOf(row, f.key).length === 0" class="cell-text">—</span>
							</div>
							<template v-else-if="f.key === titleKey && desc.titleSuffixKey && row[desc.titleSuffixKey]">
								<span class="cell-text">{{ cellText(row, f) }}</span>
								<span class="cell-key"> ({{ row[desc.titleSuffixKey] }})</span>
							</template>
							<el-switch
								v-else-if="f.type === 'boolean'"
								:model-value="Boolean(row[f.key])"
								size="small"
								@change="(v: string | number | boolean) => toggleBool(row, f.key, v)"
							/>
							<span v-else class="cell-text">{{ cellText(row, f) }}</span>
						</template>
					</el-table-column>
					<el-table-column label="排序" width="100" fixed="right">
						<template #default="{ $index }">
							<el-button size="small" circle :disabled="$index === 0" @click="move($index, -1)">
								<el-icon><ArrowUp /></el-icon>
							</el-button>
							<el-button size="small" circle :disabled="$index === items.length - 1" @click="move($index, 1)">
								<el-icon><ArrowDown /></el-icon>
							</el-button>
						</template>
					</el-table-column>
					<el-table-column label="操作" width="150" fixed="right">
						<template #default="{ $index }">
							<el-button size="small" @click="editRow($index)">编辑</el-button>
							<el-button size="small" type="danger" plain @click="removeRow($index)">删除</el-button>
						</template>
					</el-table-column>
				</el-table>
			</div>

			<MusicPlayerBar
				ref="playerBar"
				:items="itemsByKind.music ?? []"
				:track="playingTrack"
				@update:track="playingTrack = $event"
				@update:playing="trackPlaying = $event"
			/>
		</el-card>

		<el-dialog
			v-model="dialogVisible"
			:title="(editIndex >= 0 ? '编辑' : '新增') + desc.itemLabel"
			width="720px"
			top="6vh"
		>
			<el-form label-width="96px">
				<el-form-item v-for="f in formFields" :key="f.key" :label="f.label" :required="f.required">
					<el-input
						v-if="(f.type === 'text' || f.type === 'avatar') && !f.displayMap"
						v-model="form[f.key] as string"
						:placeholder="f.placeholder"
					/>
					<el-select
						v-else-if="f.type === 'text'"
						:model-value="(form[f.key] as string) ?? ''"
						filterable
						allow-create
						default-first-option
						placeholder="选择分类，或输入新键值"
						style="width: 240px"
						@update:model-value="(v: string) => (form[f.key] = v)"
					>
						<el-option
							v-for="(label, key) in f.displayMap"
							:key="key"
							:value="key"
							:label="label"
						/>
					</el-select>
					<IconInput
						v-else-if="f.type === 'icon'"
						:model-value="(form[f.key] as string) ?? ''"
						:label="String(form[titleKey] ?? '')"
						:placeholder="f.placeholder"
						@update:model-value="(v: string) => (form[f.key] = v)"
					/>
					<EntryListEditor
						v-else-if="f.type === 'entries'"
						:model-value="entriesDraft"
						:fields="f.itemFields ?? []"
						@update:model-value="(v: EntryDraft[]) => (entriesDraft = v)"
					/>
					<DateField
						v-else-if="f.type === 'date'"
						:model-value="(form[f.key] as string) ?? ''"
						@update:model-value="(v: string) => (form[f.key] = v)"
					/>
					<div v-else-if="f.type === 'image'" class="image-field">
						<div class="image-field-row">
							<el-image
								v-if="contentPreviewUrl(form[f.key])"
								class="image-field-preview"
								:src="contentPreviewUrl(form[f.key])"
								:preview-src-list="[contentPreviewUrl(form[f.key])!]"
								fit="cover"
								preview-teleported
							/>
							<div v-else class="cell-cover-fallback image-field-empty">
								<el-icon><PictureFilled /></el-icon>
							</div>
							<div class="image-field-ops">
								<el-upload
									accept="image/*"
									:show-file-list="false"
									:http-request="coverUploadRequest(f.key)"
								>
									<el-button :loading="uploadingField === f.key">
										<el-icon><Upload /></el-icon>{{ String(form[f.key] ?? "") !== "" ? "替换图片" : "上传图片" }}
									</el-button>
								</el-upload>
							</div>
						</div>

					</div>
					<div v-else-if="f.type === 'progress'" class="progress-field">
						<div class="progress-row">
							<el-select
								v-model="progressTotal"
								filterable
								allow-create
								default-first-option
								placeholder="总集数"
								class="progress-total"
							>
								<el-option v-for="n in PROGRESS_TOTALS" :key="n" :value="n" :label="`${n} 集`" />
							</el-select>
							<span class="progress-summary">
								已看 {{ progressDraft.total > 0 ? progressWatched : "?" }} / {{ progressDraft.total > 0 ? progressDraft.total : "?" }}
							</span>
						</div>
						<el-slider
							v-model="progressDraft.percent"
							:min="0"
							:max="100"
							:step="10"
							show-stops
							:format-tooltip="pctTooltip"
							:disabled="progressDraft.total <= 0"
						/>
					</div>
					<div v-else-if="f.type === 'textarea'" class="ai-textarea-field">
						<el-input
							v-model="form[f.key] as string"
							type="textarea"
							:rows="2"
							:placeholder="f.placeholder"
						/>
						<!-- 字段级 AI：有内容改写、无内容生成（AI 未启用或字段未标记时不出现） -->
						<el-tooltip
							v-if="f.ai && aiEnabled"
							:content="String(form[f.key] ?? '').trim() === '' ? 'AI生成' : 'AI改写'"
							placement="top"
						>
							<el-button
								class="ai-field-btn"
								size="small"
								:loading="fieldAiRunning && fieldAiKey === f.key"
								:disabled="fieldAiRunning"
								@click="runFieldAi(f)"
							>
								<el-icon v-if="!(fieldAiRunning && fieldAiKey === f.key)">
									<Icon icon="material-symbols:auto-awesome" />
								</el-icon>AI
							</el-button>
						</el-tooltip>
					</div>
					<el-input-number
						v-else-if="f.type === 'number'"
						v-model="form[f.key] as number"
						:step="f.key === 'rating' ? 0.1 : 1"
					/>
					<el-switch v-else-if="f.type === 'boolean'" v-model="form[f.key] as boolean" />
					<el-select
						v-else-if="f.type === 'enum'"
						v-model="form[f.key] as string"
						style="width: 240px"
					>
						<el-option v-for="o in f.enumValues" :key="o.value" :value="o.value" :label="o.label" />
					</el-select>
					<el-select
						v-else-if="f.type === 'string[]'"
						:model-value="(form[f.key] as string[]) ?? []"
						multiple
						filterable
						allow-create
						default-first-option
						reserve-keyword
						tag-type="primary"
						:placeholder="f.placeholder ?? '输入搜索，无匹配回车新建'"
						style="width: 100%"
						@update:model-value="(v: unknown) => (form[f.key] = v)"
					>
						<el-option v-for="tag in suggestionsOf(f.key)" :key="tag" :value="tag" :label="tag" />
					</el-select>
					<el-input
						v-else
						v-model="jsonDrafts[f.key]"
						type="textarea"
						:rows="3"
						class="mono"
						:placeholder="f.placeholder ?? 'JSON，留空删除该字段'"
					/>
				</el-form-item>
			</el-form>
			<template #footer>
				<el-button @click="dialogVisible = false">取消</el-button>
				<el-button type="primary" @click="confirmEdit">确定</el-button>
			</template>
		</el-dialog>

		<AnimeImportDialog v-model="animeImportVisible" :ai-enabled="aiEnabled" @apply="applyBangumi" />
		<MusicImportDialog v-model="musicImportVisible" @apply="applyMusicImport" />
		<TimelineDraftDialog v-model="timelineDraftVisible" :existing="timelineExisting" @apply="applyTimelineDrafts" />
	</div>
</template>

<style scoped>
	.data-view {
		height: 100%;
		display: flex;
		flex-direction: column;
	}
	/* 编辑弹窗：表单整体右侧留白，控件不贴边 */
	.data-view :deep(.el-dialog) {
		max-width: calc(100vw - 48px);
	}
	.data-view :deep(.el-form) {
		padding-right: 14px;
	}
	.data-tabs {
		flex: none;
	}
	.data-tabs :deep(.el-tabs__content) {
		display: none;
	}
	.page-toolbar {
		margin-bottom: 8px;
	}
	.table-wrap {
		flex: 1;
		min-height: 0;
	}
	.cell-text {
		font-size: 20px;
	}
	/* 标题列后括号附注（如书架 key） */
	.cell-key {
		font-size: 20px;
		color: var(--el-text-color-secondary);
	}
	/* 试听中的行：淡靛底色标记 */
	.data-view :deep(tr.music-playing-row > td.el-table__cell) {
		background-color: rgba(99, 102, 241, 0.07);
	}
	.cell-icon {
		display: flex;
		align-items: center;
	}
	/* 导航条目标签组：换行铺开，不与 show-overflow-tooltip 冲突 */
	.cell-entries {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.entry-chip {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		max-width: 150px;
		padding: 2px 8px;
		border: 1px solid var(--el-border-color);
		border-radius: 4px;
		background: #fff;
		font-size: 20px;
		color: var(--el-text-color-regular);
		line-height: 18px;
	}
	.entry-chip__label {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.cell-cover,
	.cell-cover-fallback {
		width: 44px;
		height: 60px;
		border-radius: 8px;
		overflow: hidden;
	}
	/* 友链头像列：方形圆角小图，点击放大与封面一致 */
	.cell-avatar,
	.cell-avatar-fallback {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		overflow: hidden;
	}
	.cell-avatar-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.14);
		color: var(--text-sub, #909399);
	}
	.cell-cover-fallback {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.14);
		color: var(--text-sub, #909399);
	}
	.image-field {
		width: 100%;
	}
	.image-field-row {
		display: flex;
		align-items: center;
		gap: 14px;
		width: 100%;
	}
	.image-field-preview,
	.image-field-empty {
		flex: none;
		width: 66px;
		height: 88px;
		border-radius: 8px;
	}
	.image-field-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.14);
		color: var(--text-sub, #909399);
	}
	.image-field-ops {
		display: flex;
		align-items: center;
		gap: 10px;
		flex: 1;
		min-width: 0;
	}
	.progress-field {
		width: 100%;
	}
	.progress-row {
		display: flex;
		align-items: center;
		gap: 14px;
	}
	.progress-total {
		width: 128px;
	}
	.progress-summary {
		font-size: 20px;
		color: var(--text-sub, #909399);
	}
	.progress-field :deep(.el-slider) {
		margin: 4px 0 0;
	}
	.mono :deep(.el-textarea__inner) {
		font-family: Consolas, "Courier New", monospace;
		font-size: 20px;
	}
	/* 字段级 AI 按钮：悬浮在 textarea 右下角内侧 */
	.ai-textarea-field {
		position: relative;
		width: 100%;
	}
	.ai-field-btn {
		position: absolute;
		right: 8px;
		bottom: 8px;
		z-index: 1;
	}
</style>
