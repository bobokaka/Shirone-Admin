<script setup lang="ts">
	import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
	import { useRouter } from "vue-router";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { Icon } from "@iconify/vue";
	import { DropdownToolbar, MdEditor, type ExposeParam, type ToolbarNames } from "md-editor-v3";
	import type { AiSettings, PostFile, PostMeta } from "@shirone-admin/shared";
	import { aiApi, mediaApi, postApi } from "../api";
	import { useAiConsoleStore } from "../stores/aiConsole";
	import { localMediaSanitize } from "../utils/content-media";
	import { sideBySideDiff, type DiffRow } from "../utils/diff";

	/**
	 * 文章编辑器面板：完整编辑页与文章管理页「就地编辑」共用同一套界面与保存逻辑。
	 * 差异仅两个开关：split 是否显示编辑器自带分栏预览；expandable 右上角是否提供「分栏编辑」跳转。
	 */
	const props = withDefaults(
		defineProps<{
			/** 文章路径（相对内容仓 content/posts） */
			path: string;
			/** 显示编辑器自带分栏预览（完整编辑页 true / 就地编辑 false） */
			split?: boolean;
			/** 右上角显示「分栏编辑」跳转按钮 */
			expandable?: boolean;
			/** 返回按钮文案 */
			backText?: string;
		}>(),
		{ split: true, expandable: false, backText: "返回" },
	);
	const emit = defineEmits<{ back: []; saved: [result: PostFile]; removed: [path: string] }>();
	const router = useRouter();

	const post = ref<PostFile | null>(null);
	const loading = ref(true);
	const saving = ref(false);
	const drawerVisible = ref(false);

	const title = ref("");
	const published = ref("");
	const publishedAt = ref<string | null>(null);
	const description = ref("");
	const image = ref("");
	const category = ref("");
	const tags = ref<string[]>([]);
	const pinned = ref(false);
	const draft = ref(false);
	const comment = ref(true);
	const encrypted = ref(false);
	const hideHomeContent = ref(true);
	const passwordHint = ref("");
	const password = ref("");
	const alias = ref("");
	const permalink = ref("");
	/** 访问路径方式：默认 /posts/slug/、别名 /posts/<别名>/、根路径 /<固定链接>/ */
	const linkMode = ref<"default" | "alias" | "permalink">("default");
	const body = ref("");

	const slug = ref("");

	/* ---------- 分类/标签候选：全量文章聚合，输入可回显，无匹配回车即新建 ---------- */

	const allPosts = ref<PostMeta[]>([]);

	function countBy(values: string[]): Array<{ name: string; n: number }> {
		const c = new Map<string, number>();
		for (const v of values) if (v.trim()) c.set(v.trim(), (c.get(v.trim()) ?? 0) + 1);
		return [...c.entries()]
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh"))
			.map(([name, n]) => ({ name, n }));
	}

	const categoryOptions = computed(() => countBy(allPosts.value.map((p) => p.category)));
	const tagOptions = computed(() => countBy(allPosts.value.flatMap((p) => p.tags)));

	/** 去首尾空白与斜杠；空值返回空串（server 收到空串即清除该键） */
	function cleanPath(v: string): string {
		return v.trim().replace(/^\/+|\/+$/g, "");
	}

	/** 当前访问地址预览 */
	const linkPreview = computed(() => {
		if (linkMode.value === "permalink") return `/${cleanPath(permalink.value) || "…"}/`;
		if (linkMode.value === "alias") return `/posts/${cleanPath(alias.value) || "…"}/`;
		return `/posts/${slug.value || "文章名"}/`;
	});

	/** 同一时刻只挂载一个编辑器，id 区分就地编辑与完整页便于排查 */
	const editorId = computed(() => (props.expandable ? "post-inline-editor" : "post-editor"));

	/** 就地编辑不显示分栏预览，预览/目录两个切换按钮一并隐藏；AI 启用时末尾追加自定义工具槽（数字 0 索引 defToolbars） */
	const toolbars = computed<ToolbarNames[]>(() => {
		const aiTail: ToolbarNames[] = aiOn.value ? ["-", 0] : [];
		return props.split
			? [
					"bold",
					"italic",
					"strikeThrough",
					"-",
					"title",
					"quote",
					"unorderedList",
					"orderedList",
					"task",
					"-",
					"codeRow",
					"code",
					"link",
					"image",
					"table",
					"-",
					"revoke",
					"next",
					"-",
					"preview",
					"catalog",
					...aiTail,
				]
			: [
					"bold",
					"italic",
					"strikeThrough",
					"-",
					"title",
					"quote",
					"unorderedList",
					"orderedList",
					"task",
					"-",
					"codeRow",
					"code",
					"link",
					"image",
					"table",
					"-",
					"revoke",
					"next",
					...aiTail,
				];
	});

	/* ---------- AI 辅助写作：工具栏下拉菜单 ---------- */

	const editorRef = ref<ExposeParam>();
	const aiSettings = ref<AiSettings | null>(null);
	/** AI 未启用时不注册工具栏槽位 */
	const aiOn = computed(() => aiSettings.value?.enable === true);
	const aiMenuVisible = ref(false);
	const aiCustomInstruction = ref("");
	/** 流式控制台全局共享：进度/停止都在面板里，这里只取 running 态禁用菜单 */
	const aiConsole = useAiConsoleStore();
	const aiRunning = computed(() => aiConsole.running);

	/** 全文改写类结果先预览再应用（完善/格式优化/无选中时的润色与自定义指令）；保留原文供左右 diff */
	const aiPreview = ref<{
		title: string;
		original: string;
		result: string;
		/** 流式进行中：diff 跟随增量刷新，应用按钮禁用 */
		streaming: boolean;
		/** 中途停止：保留已生成部分供查看，但内容不完整不允许应用 */
		stopped: boolean;
	} | null>(null);
	const aiPreviewVisible = computed({
		get: () => aiPreview.value !== null,
		set: (v: boolean) => {
			if (!v) aiPreview.value = null;
		},
	});
	/** 已展开的折叠区（键 = fold 行在 aiDiffRows 里的下标，流式期间不折叠所以稳定） */
	const expandedFolds = ref(new Set<number>());
	/** 左右对比行：流式期间不折叠（尾部一直在变），完成后再折叠长段未变行 */
	const aiDiffRows = computed<DiffRow[]>(() =>
		aiPreview.value
			? sideBySideDiff(aiPreview.value.original, aiPreview.value.result, {
					fold: !aiPreview.value.streaming,
				})
			: [],
	);
	/** 渲染行：展开的 fold 行平铺回 same 行；base 记录其所属 fold 的下标（展开状态的键） */
	const aiDiffView = computed<Array<{ row: DiffRow; base: number }>>(() => {
		const out: Array<{ row: DiffRow; base: number }> = [];
		aiDiffRows.value.forEach((row, base) => {
			if (row.kind === "fold" && expandedFolds.value.has(base)) {
				for (const hidden of row.folded ?? []) out.push({ row: hidden, base });
			} else {
				out.push({ row, base });
			}
		});
		return out;
	});
	function expandFold(base: number): void {
		expandedFolds.value = new Set(expandedFolds.value).add(base);
	}
	const diffBodyEl = ref<HTMLElement>();
	/** 变更块（连续的非 same/fold 行）在渲染行中的起始下标：上一处/下一处导航 */
	const changeBlocks = computed<number[]>(() => {
		const idxs: number[] = [];
		aiDiffView.value.forEach((item, i) => {
			const isChange = item.row.kind !== "same" && item.row.kind !== "fold";
			const prev = i > 0 ? aiDiffView.value[i - 1].row.kind : "same";
			if (isChange && (prev === "same" || prev === "fold")) idxs.push(i);
		});
		return idxs;
	});
	const currentChange = ref(0);
	function scrollToChange(rowIdx: number): void {
		const el = diffBodyEl.value?.querySelector(`[data-row="${rowIdx}"]`);
		if (!el) return;
		el.scrollIntoView({ block: "center" });
		el.classList.remove("is-flash");
		// 强制 reflow，让同一个块可重复触发高亮动画
		void (el as HTMLElement).offsetWidth;
		el.classList.add("is-flash");
	}
	function gotoChange(delta: number): void {
		const blocks = changeBlocks.value;
		if (blocks.length === 0) return;
		currentChange.value = (currentChange.value + delta + blocks.length) % blocks.length;
		scrollToChange(blocks[currentChange.value]);
	}
	/** 生成完成后跳到第一处变更（若无变更则停在顶部） */
	function jumpFirstChange(): void {
		currentChange.value = 0;
		void nextTick(() => {
			const first = changeBlocks.value[0];
			if (first !== undefined) scrollToChange(first);
		});
	}
	/** 流式期间 diff 跟着新内容往下滚（增量刷新在文末） */
	watch(
		() => aiPreview.value?.result,
		() => {
			if (!aiPreview.value?.streaming) return;
			void nextTick(() => {
				if (diffBodyEl.value) diffBodyEl.value.scrollTop = diffBodyEl.value.scrollHeight;
			});
		},
	);
	/** 长度变化超过两成时预览框红字警示（流式期间不提示，避免数字跳动） */
	const aiLengthWarn = computed(() => {
		if (!aiPreview.value || aiPreview.value.streaming) return false;
		const before = body.value.length;
		return before > 0 && Math.abs(aiPreview.value.result.length - before) / before > 0.2;
	});

	type AiAction = "improve" | "format" | "polish" | "continue" | "summary" | "custom";

	/** AI 菜单项：图标 + 「AI」前缀文案，一眼可辨 */
	const AI_ACTIONS: Array<{ id: Exclude<AiAction, "custom">; icon: string; label: string }> = [
		{ id: "improve", icon: "material-symbols:auto-fix-high", label: "AI完善内容（全文）" },
		{ id: "format", icon: "material-symbols:format-align-left", label: "AI格式优化（全文）" },
		{ id: "polish", icon: "material-symbols:brush", label: "AI润色（选中文本优先）" },
		{ id: "continue", icon: "material-symbols:edit-note", label: "AI续写（追加文末）" },
		{ id: "summary", icon: "material-symbols:summarize", label: "AI生成摘要（回填文章信息）" },
	];

	/** 服务端 /api/ai/edit 的单次文本上限（字符） */
	const AI_TEXT_LIMIT = 100_000;

	/**
	 * 全文改写类公共流程：先开 diff 弹窗，AI 结果流式刷进右列（节流 200ms），
	 * 完成后启用应用并跳到第一处变更；停止但已有产出时保留查看（不允许应用）。
	 */
	async function runPreviewAction(title: string, instruction: string, maxTokens: number): Promise<void> {
		const original = body.value;
		expandedFolds.value = new Set();
		currentChange.value = 0;
		aiPreview.value = { title, original, result: "", streaming: true, stopped: false };
		let live = "";
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const result = await aiConsole.run(`AI${title}`, { instruction, text: original, maxTokens }, {
			onText: (full) => {
				live = full;
				if (!flushTimer) {
					flushTimer = setTimeout(() => {
						flushTimer = null;
						if (aiPreview.value) aiPreview.value.result = live;
					}, 200);
				}
			},
		});
		if (flushTimer) clearTimeout(flushTimer);
		// 流式期间用户已放弃/关闭弹窗（aiPreview 被清空）：不再重新打开
		if (aiPreview.value === null) return;
		if (result !== null) {
			aiPreview.value = { title, original, result, streaming: false, stopped: false };
			jumpFirstChange();
			return;
		}
		if (live.trim() !== "" && aiConsole.lastOutcome === "stopped") {
			aiPreview.value = { title, original, result: live, streaming: false, stopped: true };
			return;
		}
		// 失败/停止但无产出：错误已在控制台展示，弹窗无内容可看
		aiPreview.value = null;
	}

	async function runAiAction(id: AiAction): Promise<void> {
		if (aiRunning.value) return;
		if (body.value.trim() === "") {
			ElMessage.warning("正文为空，先写点什么再让 AI 处理");
			return;
		}
		if (body.value.length > AI_TEXT_LIMIT) {
			ElMessage.warning(`正文超过 ${AI_TEXT_LIMIT} 字符，超出 AI 单次处理上限`);
			return;
		}
		aiMenuVisible.value = false;
		const selected = (editorRef.value?.getSelectedText() ?? "").trim();
		// 全走流式控制台：思考/正文实时上屏、可随时停止；null 即停止/失败，原文不动
		let result: string | null = null;

		if (id === "improve" || id === "format") {
			const isImprove = id === "improve";
			const instruction = isImprove
				? "完善这篇 Markdown 文章：补全论述缺口、增强逻辑衔接与技术细节的准确性，保留原有观点、语气、代码与私有扩展语法（三冒号容器、file-tree 等原样保留）。输出完善后的完整正文。"
				: "优化这篇 Markdown 文章的格式：规范标题层级、列表与引用格式、统一中英文标点与空格、补全代码围栏语言标注、修正排版问题，不改动内容表述。输出完整正文。";
			await runPreviewAction(isImprove ? "完善内容" : "格式优化", instruction, 16384);
			return;
		}

		if (id === "polish") {
			if (selected !== "") {
				result = await aiConsole.run("AI润色（选中）", {
					instruction: "润色以下文字：表达更流畅自然，保留原意与技术准确性，只输出润色结果。",
					text: selected,
					maxTokens: 8192,
				});
				if (result !== null) {
					const text = result;
					editorRef.value?.insert(() => ({ targetValue: text, select: true }));
					ElMessage.success("已替换选中内容");
				}
			} else {
				await runPreviewAction(
					"润色",
					"润色这篇 Markdown 文章：表达更流畅自然，保留原意、代码与私有扩展语法，输出完整正文。",
					16384,
				);
			}
			return;
		}

		if (id === "continue") {
			result = await aiConsole.run("AI续写", {
				instruction:
					"续写这篇文章：从当前结尾自然延续，保持语气、人称与 Markdown 格式一致，只输出续写的新内容，不要重复已有内容。",
				text: body.value,
				maxTokens: 8192,
			});
			if (result !== null) {
				body.value = `${body.value.replace(/\s+$/, "")}\n\n${result}\n`;
				ElMessage.success("已追加到文末");
			}
			return;
		}

		if (id === "summary") {
			result = await aiConsole.run("AI生成摘要", {
				instruction: "为这篇文章生成 80-160 字的中文摘要：概括主题与关键要点，客观陈述，只输出摘要本身。",
				text: body.value,
				maxTokens: 1024,
			});
			if (result === null) return;
			if (description.value.trim() !== "") {
				try {
					await ElMessageBox.confirm("文章信息中的摘要已有内容，覆盖为 AI 摘要？", "生成摘要", {
						type: "warning",
						confirmButtonText: "覆盖",
						cancelButtonText: "取消",
					});
				} catch {
					return; // 用户取消
				}
			}
			description.value = result;
			drawerVisible.value = true;
			ElMessage.success("摘要已回填文章信息");
			return;
		}

		// 自定义指令：有选中作用于选中，无选中作用于全文（预览后应用）
		const instruction = aiCustomInstruction.value.trim();
		if (instruction === "") return;
		if (selected !== "") {
			result = await aiConsole.run("AI自定义指令（选中）", { instruction, text: selected, maxTokens: 8192 });
			if (result !== null) {
				const text = result;
				editorRef.value?.insert(() => ({ targetValue: text, select: true }));
				ElMessage.success("已替换选中内容");
			}
		} else {
			await runPreviewAction("自定义指令", instruction, 16384);
		}
	}

	function applyAiResult(): void {
		if (!aiPreview.value) return;
		body.value = aiPreview.value.result;
		aiPreview.value = null;
		ElMessage.success("已应用到正文");
	}

	async function copyAiResult(): Promise<void> {
		if (!aiPreview.value) return;
		try {
			await navigator.clipboard.writeText(aiPreview.value.result);
			ElMessage.success("已复制");
		} catch {
			ElMessage.error("复制失败，可在文本框中手动复制");
		}
	}

	function fill(p: PostFile): void {
		post.value = p;
		slug.value = p.meta.slug;
		title.value = p.meta.title;
		published.value = p.meta.published;
		publishedAt.value = p.meta.publishedAt ?? null;
		description.value = p.meta.description;
		image.value = p.meta.image;
		category.value = p.meta.category;
		tags.value = [...p.meta.tags];
		pinned.value = p.meta.pinned;
		draft.value = p.meta.draft;
		comment.value = p.meta.comment;
		encrypted.value = p.meta.encrypted;
		hideHomeContent.value = p.meta.hideHomeContent;
		passwordHint.value = p.meta.passwordHint;
		alias.value = p.meta.alias ?? "";
		permalink.value = p.meta.permalink ?? "";
		linkMode.value = p.meta.permalink ? "permalink" : p.meta.alias ? "alias" : "default";
		body.value = p.body;
	}

	onMounted(async () => {
		try {
			fill(await postApi.detail(props.path));
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loading.value = false;
		}
		// 候选聚合失败不拦编辑，仅无回显
		postApi
			.list()
			.then((r) => (allPosts.value = r))
			.catch(() => {});
		// AI 配置只读一次：决定是否挂 AI 工具栏
		aiApi
			.getSettings()
			.then((s) => (aiSettings.value = s))
			.catch(() => {});
	});

	/** publishedAt 的日期部分始终跟随 published（Asia/Shanghai +08:00），消除主题的时区硬校验失败 */
	function normalizedPublishedAt(): string | undefined {
		if (!publishedAt.value) return undefined;
		const m = publishedAt.value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
		const hh = m?.[1] ?? "10";
		const mm = m?.[2] ?? "00";
		const ss = m?.[3] ?? "00";
		return `${published.value}T${hh}:${mm}:${ss}+08:00`;
	}

	async function save(silent = false): Promise<boolean> {
		if (!post.value) {
			ElMessage.error("文章未加载成功，无法保存（请刷新页面重试）");
			return false;
		}
		if (!title.value.trim()) {
			ElMessage.warning("标题不能为空");
			return false;
		}
		saving.value = true;
		try {
			const filled = post.value;
			const bodyBefore = body.value;
			const result = await postApi.save({
				path: props.path,
				body: body.value,
				password: password.value || undefined,
				clearPassword: !encrypted.value,
				meta: {
					title: title.value,
					published: published.value,
					publishedAt: normalizedPublishedAt() ?? "",
					description: description.value,
					image: image.value,
					category: category.value,
					tags: tags.value,
					pinned: pinned.value,
					draft: draft.value,
					comment: comment.value,
					encrypted: encrypted.value,
					hideHomeContent: hideHomeContent.value,
					passwordHint: passwordHint.value,
					// 两键始终显式传值：非当前模式的键传空串，server 会清除旧值
					alias: linkMode.value === "alias" ? cleanPath(alias.value) : "",
					permalink: linkMode.value === "permalink" ? cleanPath(permalink.value) : "",
					updated: filled.meta.updated ?? "",
					updatedAt: filled.meta.updatedAt ?? "",
				},
			});
			fill(result);
			// 服务端序列化会 trim 正文并保证单个文末换行：首尾空白差异时保留编辑器原文，
			// 避免 10s 自动保存重置内容把输入中的光标顶掉；基线同步为编辑器值以免假“脏”
			if (bodyBefore !== result.body && bodyBefore.trim() === result.body.trim()) {
				body.value = bodyBefore;
				post.value = { ...result, body: bodyBefore };
			}
			password.value = "";
			emit("saved", result);
			if (!silent) ElMessage.success("已保存");
			return true;
		} catch (e) {
			ElMessage.error((e as Error).message);
			return false;
		} finally {
			saving.value = false;
		}
	}

	async function saveThenPublish(): Promise<void> {
		if (await save(true)) {
			ElMessage.success("已保存，可去发布页提交");
			router.push("/publish");
		}
	}

	async function remove(): Promise<void> {
		try {
			await ElMessageBox.confirm(
				`删除「${title.value}」及其目录下全部配图？已提交过 git 的内容可从历史恢复。`,
				"删除文章",
				{ type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
			);
		} catch {
			return; // 用户取消
		}
		await postApi.remove(props.path);
		ElMessage.success("已删除");
		emit("removed", props.path);
	}

	async function uploadCover(file: File): Promise<void> {
		try {
			const r = await mediaApi.postImage(slug.value, file);
			image.value = r.src;
			ElMessage.success("封面已上传");
		} catch (e) {
			ElMessage.error((e as Error).message);
		}
	}

	async function onUploadImg(
		files: File[],
		callback: (urls: Array<{ url: string; alt: string; title: string }> | string) => void,
	): Promise<void> {
		try {
			const results = await Promise.all(files.map((f) => mediaApi.postImage(slug.value, f)));
			callback(results.map((r) => ({ url: r.src, alt: "", title: "" })));
		} catch (e) {
			callback((e as Error).message);
		}
	}

	/** 分栏预览的本地媒体地址重写（./images/ 按当前文章目录、/ 与 assets/ 按站点目录） */
	function editorSanitize(html: string): string {
		return localMediaSanitize(html, post.value?.meta.path);
	}

	/* ---------- 自动保存：10s 落一次盘，返回/切分栏/切换文章/卸载前静默保存，不再弹确认 ---------- */

	/** 是否有未落盘修改（标题或正文） */
	function isDirty(): boolean {
		return (
			!!post.value && (body.value !== post.value.body || title.value !== post.value.meta.title)
		);
	}

	/** 最近一次自动保存时间（HH:mm:ss），展示在顶栏；手动保存不更新 */
	const lastAutoSavedAt = ref("");

	function nowText(): string {
		return new Date().toLocaleTimeString("zh-CN", { hour12: false });
	}

	/** 有改动才静默保存；保存中/未加载/标题为空跳过。返回是否“可以继续离开” */
	async function autoSaveIfDirty(): Promise<boolean> {
		if (!isDirty() || saving.value || !post.value) return true;
		if (!title.value.trim()) {
			// 标题为空无法落盘：这是唯一会拦下的情况（新文章只起了个正文没起标题）
			ElMessage.warning("标题为空无法自动保存，请先填写标题或手动放弃");
			return false;
		}
		const ok = await save(true);
		if (ok) lastAutoSavedAt.value = nowText();
		return ok;
	}

	let autoSaveTimer: ReturnType<typeof setInterval> | null = null;
	onMounted(() => {
		autoSaveTimer = setInterval(() => {
			void autoSaveIfDirty();
		}, 10_000);
	});
	onBeforeUnmount(() => {
		if (autoSaveTimer) clearInterval(autoSaveTimer);
		// 卸载即保存：切换文章 / 路由离开 / 关闭编辑都走这里（fire-and-forget）
		void autoSaveIfDirty();
	});

	async function back(): Promise<void> {
		if (!(await autoSaveIfDirty())) return;
		emit("back");
	}

	/** 分栏编辑：进入完整编辑页（同一编辑器的分栏预览形态）；from 标记供返回时恢复单栏编辑态 */
	async function expand(): Promise<void> {
		if (!(await autoSaveIfDirty())) return;
		router.push({ path: "/posts/edit", query: { path: props.path, from: "inline" } });
	}

	defineExpose({ autoSaveIfDirty });
</script>

<template>
	<div v-loading="loading" class="editor-panel">
		<div class="editor-top">
			<el-button text @click="back">
				<el-icon><ArrowLeft /></el-icon>{{ backText }}
			</el-button>
			<el-input v-model="title" class="title-input" placeholder="文章标题" />
			<el-button @click="drawerVisible = true">
				<el-icon><InfoFilled /></el-icon>文章信息
			</el-button>
			<el-button type="danger" plain @click="remove">删除</el-button>
			<el-button type="primary" :loading="saving" @click="save()">保存</el-button>
			<el-button type="success" :loading="saving" @click="saveThenPublish">保存并去发布</el-button>
			<span v-if="lastAutoSavedAt" class="auto-save-hint">已自动保存 {{ lastAutoSavedAt }}</span>
			<!-- 分栏编辑图标：竖向分隔 + 左右两栏（本地 material-symbols 集合，无网络请求） -->
			<el-tooltip v-if="expandable" content="分栏编辑（左右分栏预览）" placement="bottom">
				<el-button circle aria-label="分栏编辑" @click="expand">
					<el-icon><Icon icon="material-symbols:vertical-split" /></el-icon>
				</el-button>
			</el-tooltip>
		</div>

		<div class="editor-wrap">
			<!-- 注意：唯一标识必须用 editorId prop；若误用 :id 会作为透传 attr 覆盖根元素内部 id，
				     组件内部 rebindEvent 按 #editorId 查 .cm-scroller 会落空，抛 null.addEventListener
				     并打断 Vue post-flush（文章加载/弹窗全部失灵） -->
			<MdEditor
				ref="editorRef"
				:editor-id="editorId"
				v-model="body"
				:toolbars="toolbars"
				:footers="[]"
				:preview="split"
				:sanitize="editorSanitize"
				placeholder="正文使用标准 Markdown 语法"
				@on-upload-img="onUploadImg"
			>
				<!-- AI 下拉工具：数字槽位 0；overlay 渲染在编辑器 DOM 内，只放原生元素避免弹层冲突 -->
				<template v-if="aiOn" #defToolbars>
					<DropdownToolbar
						:visible="aiMenuVisible"
						title="AI 助手"
						@on-change="(v: boolean) => (aiMenuVisible = v)"
					>
						<template #trigger>
							<span class="ai-toolbar-trigger" :class="{ 'is-busy': aiRunning }">
								<el-icon v-if="aiRunning" class="is-loading"><Loading /></el-icon>
								<Icon v-else icon="material-symbols:auto-awesome" />
								<em class="ai-toolbar-text">AI</em>
							</span>
						</template>
						<template #overlay>
							<div class="ai-toolbar-menu">
								<button
									v-for="a in AI_ACTIONS"
									:key="a.id"
									type="button"
									:disabled="aiRunning"
									@click="runAiAction(a.id)"
								>
									<el-icon><Icon :icon="a.icon" /></el-icon>{{ a.label }}
								</button>
								<div class="ai-toolbar-custom">
									<input
										v-model="aiCustomInstruction"
										type="text"
										placeholder="自定义指令…"
										@keydown.enter.prevent="runAiAction('custom')"
									/>
									<button
										type="button"
										:disabled="aiRunning || aiCustomInstruction.trim() === ''"
										@click="runAiAction('custom')"
									>
										<el-icon><Icon icon="material-symbols:send" /></el-icon>AI执行
									</button>
								</div>
							</div>
						</template>
					</DropdownToolbar>
				</template>
			</MdEditor>
		</div>

		<el-drawer v-model="drawerVisible" title="文章信息" size="480px">
			<div class="drawer-meta muted">{{ path }}</div>
			<el-form label-position="top" class="drawer-form">
				<el-form-item label="发布日期">
					<el-date-picker
						v-model="published"
						type="date"
						value-format="YYYY-MM-DD"
						style="width: 100%"
					/>
				</el-form-item>
				<el-form-item label="精确时间">
					<el-date-picker
						v-model="publishedAt"
						type="datetime"
						value-format="YYYY-MM-DDTHH:mm:ssZ"
						placeholder="同日多篇排序用"
						style="width: 100%"
						clearable
					/>
				</el-form-item>
				<el-form-item label="分类">
					<el-select
						v-model="category"
						filterable
						allow-create
						default-first-option
						clearable
						placeholder="选择已有，或输入新建"
						style="width: 100%"
					>
						<el-option v-for="c in categoryOptions" :key="c.name" :value="c.name" :label="c.name">
							<span>{{ c.name }}</span>
							<span class="opt-count">{{ c.n }} 篇</span>
						</el-option>
					</el-select>
				</el-form-item>
				<el-form-item label="标签">
					<el-select
						v-model="tags"
						multiple
						filterable
						allow-create
						default-first-option
						reserve-keyword
						placeholder="选择已有，或输入回车新建"
						style="width: 100%"
					>
						<el-option v-for="t in tagOptions" :key="t.name" :value="t.name" :label="t.name">
							<span>{{ t.name }}</span>
							<span class="opt-count">{{ t.n }} 次</span>
						</el-option>
					</el-select>
				</el-form-item>
				<el-form-item label="摘要">
					<el-input v-model="description" type="textarea" :rows="2" placeholder="留空自动截取正文前段" />
				</el-form-item>
				<el-form-item label="封面">
					<el-input v-model="image" placeholder="./images/cover.webp 或外链">
						<template #append>
							<label class="cover-upload">
								上传
								<input
									type="file"
									accept=".webp,.png,.jpg,.jpeg,.gif,.avif"
									hidden
									@change="(e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) uploadCover(f); }"
								/>
							</label>
						</template>
					</el-input>
				</el-form-item>
				<el-form-item label="开关">
					<el-checkbox v-model="draft">草稿</el-checkbox>
					<el-checkbox v-model="pinned">置顶</el-checkbox>
					<el-checkbox v-model="comment">评论</el-checkbox>
					<el-checkbox v-model="encrypted">加密</el-checkbox>
				</el-form-item>
				<template v-if="encrypted">
					<el-form-item label="访问密码">
						<el-input
							v-model="password"
							:placeholder="post?.meta.hasPassword ? '已设置，输入则修改' : '设置访问密码'"
							clearable
						/>
					</el-form-item>
					<el-form-item label="密码提示">
						<el-input v-model="passwordHint" />
					</el-form-item>
					<el-form-item label="首页卡片隐藏预览">
						<el-switch v-model="hideHomeContent" />
					</el-form-item>
				</template>
				<el-form-item label="访问路径">
					<div class="link-mode">
						<el-radio-group v-model="linkMode">
							<el-radio value="default">默认（/posts/文章名/）</el-radio>
							<el-radio value="alias">自定义别名（/posts/别名/）</el-radio>
							<el-radio value="permalink">根路径固定链接（/自定义路径/）</el-radio>
						</el-radio-group>
						<el-input
							v-if="linkMode === 'alias'"
							v-model="alias"
							placeholder="如 hello，访问 /posts/hello/"
						>
							<template #prepend>/posts/</template>
						</el-input>
						<el-input
							v-if="linkMode === 'permalink'"
							v-model="permalink"
							placeholder="如 notes/foo，访问 /notes/foo/"
						>
							<template #prepend>/</template>
						</el-input>
						<div class="muted link-preview">当前访问地址：{{ linkPreview }}</div>
					</div>
				</el-form-item>
			</el-form>
			<template #footer>
				<el-button @click="drawerVisible = false">收起</el-button>
				<el-button type="primary" :loading="saving" @click="save()">保存</el-button>
			</template>
		</el-drawer>

		<!-- 全文改写类 AI 结果：IDEA 式左右 diff（行号槽 + 行级增删标记 + 折叠未变行），
			     AI 生成期间即打开并流式刷新右列，完成后可逐处跳转变更 -->
		<el-dialog
			v-model="aiPreviewVisible"
			:title="`AI 结果 — ${aiPreview?.title ?? ''}`"
			width="min(1200px, 96%)"
			top="4vh"
			class="ai-preview-dialog"
		>
			<div class="ai-preview-status">
				<el-tag v-if="aiPreview?.streaming" size="small" effect="plain">AI 生成中…</el-tag>
				<el-tag v-else-if="aiPreview?.stopped" size="small" type="warning" effect="plain">
					已停止（内容不完整，不能应用）
				</el-tag>
				<el-tag v-else-if="aiLengthWarn" size="small" type="danger" effect="plain">
					长度 {{ body.length }} → {{ aiPreview?.result.length ?? 0 }} 字符，变化较大请核对
				</el-tag>
				<span class="diff-count">共 {{ changeBlocks.length }} 处变更</span>
				<span class="diff-nav-spacer" />
				<el-button
					size="small"
					text
					:disabled="changeBlocks.length === 0"
					@click="gotoChange(-1)"
				>
					<el-icon><ArrowUp /></el-icon>上一处
				</el-button>
				<el-button
					size="small"
					text
					:disabled="changeBlocks.length === 0"
					@click="gotoChange(1)"
				>
					<el-icon><ArrowDown /></el-icon>下一处
				</el-button>
			</div>
			<div class="diff-wrap">
				<div class="diff-head">
					<span class="diff-head-cell">原文</span>
					<span class="diff-head-cell">AI 结果</span>
				</div>
				<div ref="diffBodyEl" class="diff-body">
					<div
						v-for="(item, i) in aiDiffView"
						:key="i"
						class="diff-row"
						:class="item.row.kind"
						:data-row="i"
					>
						<button
							v-if="item.row.kind === 'fold'"
							type="button"
							class="diff-fold"
							@click="expandFold(item.base)"
						>
							⋯ 展开折叠的 {{ item.row.folded?.length ?? 0 }} 行未变内容
						</button>
						<template v-else>
							<div class="diff-gutter gl">{{ item.row.left.lineNo ?? "" }}</div>
							<div class="diff-cell left">
								<span
									v-if="item.row.kind === 'del' || item.row.kind === 'change'"
									class="row-mark del"
								>−</span>
								<span
									v-for="(seg, j) in item.row.left.segs"
									:key="j"
									class="seg"
									:class="seg.kind"
								>{{ seg.text }}</span>
							</div>
							<div class="diff-gutter gr">{{ item.row.right.lineNo ?? "" }}</div>
							<div class="diff-cell right">
								<span
									v-if="item.row.kind === 'ins' || item.row.kind === 'change'"
									class="row-mark ins"
								>+</span>
								<span
									v-for="(seg, j) in item.row.right.segs"
									:key="j"
									class="seg"
									:class="seg.kind"
								>{{ seg.text }}</span>
							</div>
						</template>
					</div>
				</div>
				<div class="diff-legend">
					<span class="legend-item"><i class="dot del" />删除行</span>
					<span class="legend-item"><i class="dot ins" />新增行</span>
					<span class="legend-item">
						<span class="seg del">行内删除</span><span class="seg ins">行内新增</span>
					</span>
				</div>
			</div>
			<template #footer>
				<el-button :disabled="aiPreview?.streaming || !aiPreview?.result" @click="copyAiResult">
					复制结果
				</el-button>
				<el-button @click="aiPreview = null">放弃</el-button>
				<el-tooltip content="已停止：内容不完整，请重新生成" :disabled="!aiPreview?.stopped" placement="top">
					<span class="apply-wrap">
						<el-button
							type="primary"
							:disabled="aiPreview?.streaming || aiPreview?.stopped"
							@click="applyAiResult"
						>
							应用替换
						</el-button>
					</span>
				</el-tooltip>
			</template>
		</el-dialog>
	</div>
</template>

<style scoped>
	.editor-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}
	.editor-top {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-bottom: 12px;
	}
	.title-input {
		flex: 1;
		min-width: 0;
	}
	.title-input :deep(.el-input__wrapper) {
		font-size: 20px;
		font-weight: 600;
		padding: 4px 14px;
	}
	.editor-wrap {
		flex: 1;
		min-height: 0;
	}
	.editor-wrap :deep(.md-editor) {
		--md-bk-color: rgba(255, 255, 255, 0.55);
		height: 100%;
		border-radius: 14px;
		border: 1px solid var(--glass-border-soft);
		box-shadow: var(--glass-shadow);
	}
	/* 正文 ≥ 20px：编辑器源码区（CodeMirror 正文）与预览区文字同步抬高 */
	.editor-wrap :deep(.cm-content),
	.editor-wrap :deep(.md-editor-preview) {
		font-size: 20px;
	}
	.drawer-meta {
		font-size: 20px;
		margin-bottom: 12px;
		word-break: break-all;
	}
	.drawer-form :deep(.el-form-item) {
		margin-bottom: 14px;
	}
	.drawer-form :deep(.el-collapse) {
		border: none;
	}
	.cover-upload {
		cursor: pointer;
	}
	/* 访问路径：单选竖排 + 条件输入 + 地址预览 */
	.link-mode {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 8px;
		width: 100%;
	}
	.link-mode .el-radio-group {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
	}
	.link-mode .el-input {
		width: 100%;
	}
	.link-preview {
		font-size: 20px;
	}
	/* 下拉候选项右侧的使用次数 */
	.opt-count {
		float: right;
		color: var(--el-text-color-secondary);
		font-size: 16px;
	}
	/* AI 工具栏触发器：图标 + 「AI」文字（区别于纯图标工具，一眼可辨） */
	.ai-toolbar-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: 24px;
		padding: 0 5px;
		font-size: 18px;
		color: inherit;
	}
	.ai-toolbar-text {
		font-style: normal;
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
	}
	.ai-toolbar-menu {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 240px;
		padding: 6px;
	}
	.ai-toolbar-menu button {
		appearance: none;
		border: none;
		background: transparent;
		text-align: left;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 7px 10px;
		font-size: 20px;
		border-radius: 6px;
		cursor: pointer;
		color: inherit;
	}
	.ai-toolbar-menu button .el-icon {
		font-size: 16px;
		opacity: 0.75;
	}
	.ai-toolbar-menu button:hover:not(:disabled) {
		background: rgba(128, 128, 128, 0.16);
	}
	.ai-toolbar-menu button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.ai-toolbar-custom {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
		padding: 6px 4px 2px;
		border-top: 1px solid rgba(128, 128, 128, 0.25);
	}
	.ai-toolbar-custom button {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		flex-shrink: 0;
	}
	.ai-toolbar-custom button .el-icon {
		font-size: 14px;
	}
	.ai-toolbar-custom input {
		flex: 1;
		min-width: 0;
		border: 1px solid rgba(128, 128, 128, 0.35);
		border-radius: 6px;
		padding: 5px 8px;
		font-size: 20px;
		background: transparent;
		color: inherit;
		outline: none;
	}
	.ai-length-warn {
		color: var(--el-color-danger);
		font-size: 20px;
		margin-bottom: 8px;
	}
	/* 顶栏自动保存时间提示 */
	.auto-save-hint {
		font-size: 16px;
		color: var(--el-text-color-placeholder);
		white-space: nowrap;
	}
	/* 弹窗状态条：生成中/已停止标签 + 变更计数 + 上一处/下一处导航 */
	.ai-preview-status {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 8px;
	}
	.diff-count {
		font-size: 16px;
		color: var(--el-text-color-secondary);
	}
	.diff-nav-spacer {
		flex: 1;
	}
	.apply-wrap {
		margin-left: 12px;
	}
	/* IDEA 式左右 diff：行号槽 + 行级红绿底 + +/− 行标记；行内再叠加字符级片段 */
	.diff-wrap {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		overflow: hidden;
	}
	.diff-head {
		display: grid;
		grid-template-columns: 46px 1fr 46px 1fr;
		background: var(--el-fill-color-light);
		border-bottom: 1px solid var(--el-border-color-lighter);
		font-size: 20px;
		font-weight: 600;
		color: var(--el-text-color-secondary);
	}
	.diff-head-cell {
		grid-column: span 2;
		padding: 6px 12px;
	}
	.diff-head-cell + .diff-head-cell {
		border-left: 1px solid var(--el-border-color-lighter);
	}
	.diff-body {
		max-height: 62vh;
		overflow: auto;
		font-family: var(--font-mono, ui-monospace, Consolas, monospace);
		font-size: 20px;
		line-height: 1.7;
	}
	.diff-row {
		display: grid;
		grid-template-columns: 46px 1fr 46px 1fr;
	}
	.diff-row:hover {
		background: var(--el-fill-color-extra-light);
	}
	.diff-row.is-flash {
		animation: diff-flash 1.2s ease-out;
	}
	@keyframes diff-flash {
		0% {
			background: rgb(64 158 255 / 22%);
		}
		100% {
			background: transparent;
		}
	}
	.diff-gutter {
		padding: 0 6px 0 4px;
		text-align: right;
		color: var(--el-text-color-placeholder);
		font-size: 11px;
		background: var(--el-fill-color-lighter);
		user-select: none;
		min-height: 1.7em;
		display: flex;
		align-items: flex-start;
		justify-content: flex-end;
		padding-top: 1px;
	}
	.diff-gutter.gr {
		border-left: 1px solid var(--el-border-color-lighter);
	}
	.diff-cell {
		padding: 0 10px;
		min-height: 1.7em;
		white-space: pre-wrap;
		word-break: break-word;
	}
	/* 行级标记：删除行左侧红底、新增行右侧绿底（与行内片段底色区分：行级是淡色整行） */
	.diff-row.del .diff-gutter.gl,
	.diff-row.change .diff-gutter.gl {
		background: rgb(245 108 108 / 14%);
		color: var(--el-color-danger);
		font-weight: 600;
	}
	.diff-row.del .diff-cell.left,
	.diff-row.change .diff-cell.left {
		background: rgb(245 108 108 / 9%);
	}
	.diff-row.ins .diff-gutter.gr,
	.diff-row.change .diff-gutter.gr {
		background: rgb(103 194 58 / 14%);
		color: var(--el-color-success);
		font-weight: 600;
	}
	.diff-row.ins .diff-cell.right,
	.diff-row.change .diff-cell.right {
		background: rgb(103 194 58 / 9%);
	}
	.row-mark {
		display: inline-block;
		width: 1.1em;
		font-weight: 700;
		margin-right: 2px;
	}
	.row-mark.del {
		color: var(--el-color-danger);
	}
	.row-mark.ins {
		color: var(--el-color-success);
	}
	/* 折叠占位行：整行一条「展开 N 行」按钮 */
	.diff-row.fold {
		display: block;
	}
	.diff-fold {
		display: block;
		width: 100%;
		border: none;
		border-top: 1px dashed var(--el-border-color-lighter);
		border-bottom: 1px dashed var(--el-border-color-lighter);
		background: var(--el-fill-color-light);
		padding: 4px 12px;
		font-size: 20px;
		font-family: inherit;
		color: var(--el-text-color-secondary);
		cursor: pointer;
		text-align: left;
	}
	.diff-fold:hover {
		color: var(--el-color-primary);
		background: var(--el-fill-color);
	}
	.seg.del {
		color: var(--el-color-danger);
		text-decoration: line-through;
		background: #fdf3c8;
		border-radius: 2px;
	}
	.seg.ins {
		background: #cdeec9;
		border-radius: 2px;
	}
	/* 底部图例 */
	.diff-legend {
		display: flex;
		gap: 14px;
		align-items: center;
		padding: 6px 12px;
		border-top: 1px solid var(--el-border-color-lighter);
		background: var(--el-fill-color-light);
		font-size: 20px;
	}
	.legend-item {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		color: var(--el-text-color-secondary);
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 2px;
		display: inline-block;
	}
	.dot.del {
		background: rgb(245 108 108 / 30%);
	}
	.dot.ins {
		background: rgb(103 194 58 / 30%);
	}
</style>
