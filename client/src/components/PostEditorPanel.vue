<script setup lang="ts">
	import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
	import { useRouter } from "vue-router";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { Icon } from "@iconify/vue";
	import { DropdownToolbar, MdEditor, NormalToolbar, type ExposeParam, type ToolbarNames } from "md-editor-v3";
	import type { AiSettings, PostFile, PostMeta } from "@shirone-admin/shared";
	import { aiApi, mediaApi, postApi } from "../api";
	import { useTheme } from "../composables/useTheme";
	import { useAiConsoleStore } from "../stores/aiConsole";
	import { localMediaSanitize, previewUrlOf } from "../utils/content-media";
	import { sideBySideDiff, type DiffRow } from "../utils/diff";

	/**
	 * 文章编辑器面板：完整编辑页与文章管理页「就地编辑」共用同一套界面与保存逻辑。
	 * 差异仅两个开关：split 是否显示编辑器自带分栏预览；expandable 编辑器工具栏最右是否提供「分栏编辑」跳转。
	 */
	const props = withDefaults(
		defineProps<{
			/** 文章路径（相对内容仓 content/posts） */
			path: string;
			/** 显示编辑器自带分栏预览（完整编辑页 true / 就地编辑 false） */
			split?: boolean;
			/** 编辑器工具栏最右显示「分栏编辑」跳转按钮 */
			expandable?: boolean;
			/** 返回按钮文案 */
			backText?: string;
		}>(),
		{ split: true, expandable: false, backText: "返回" },
	);
	const emit = defineEmits<{ back: []; saved: [result: PostFile]; removed: [path: string] }>();
	const router = useRouter();
	const { isDark } = useTheme();

	const post = ref<PostFile | null>(null);
	const loading = ref(true);
	const saving = ref(false);
	const drawerVisible = ref(false);

	const title = ref("");
	/** 发布日期（只读，YYYY-MM-DDTHH:mm:ss）：实际值由后端在发布那一刻盖戳，前端仅展示 */
	const publishedAt = ref("");
	/** 只读展示格式：2026-09-16 08:30:25 */
	const publishedDisplay = computed(() => publishedAt.value.replace("T", " "));
	/** 封面预览直链：文章相对 images/ 走 /content-posts 代理，其余按通用规则换算 */
	const coverPreview = computed(() => {
		const s = image.value.trim();
		if (!s || /^(https?:)?\/\//i.test(s) || s.startsWith("data:")) return s;
		const dir = props.path
			.replace(/\\/g, "/")
			.replace(/\/index\.md$/, "")
			.replace(/\.md$/, "");
		if (/^(\.{1,2}\/)?images\//.test(s)) return `/content-posts/${dir}/${s.replace(/^(\.{1,2}\/)?/, "")}`;
		return previewUrlOf(s);
	});
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

	/** 同一时刻只挂载一个编辑器，id 区分就地编辑与完整页便于排查 */
	const editorId = computed(() => (props.expandable ? "post-inline-editor" : "post-editor"));

	/** 就地编辑不显示分栏预览，预览/目录两个切换按钮一并隐藏；工具栏尾部挂自定义槽（数字 = defToolbars
	 *  槽内第 N 个实际渲染的子组件）：AI 下拉（启用时索引 0）在先，分栏相关按钮（预览/目录、
	 *  分栏编辑跳转）一律排在其右侧 */
	const toolbars = computed<ToolbarNames[]>(() => {
		const base: ToolbarNames[] = [
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
		];
		if (aiOn.value) base.push("-", 0);
		if (props.split) base.push("-", "preview", "catalog");
		if (props.expandable) base.push("-", aiOn.value ? 1 : 0);
		return base;
	});

	/* ---------- AI 辅助写作：工具栏下拉菜单 ---------- */

	const editorRef = ref<ExposeParam>();
	const aiSettings = ref<AiSettings | null>(null);
	/** AI 未启用时不注册工具栏槽位 */
	const aiOn = computed(() => aiSettings.value?.enable === true);
	const aiMenuVisible = ref(false);
	const aiCustomInstruction = ref("");
	/* 下拉是纯悬停型（mouseleave 即收起）：输入自定义指令期间挂起悬停收起，
	   改为焦点离开菜单才收起，否则打字时手一移开菜单就没了 */
	const aiMenuEl = ref<HTMLElement>();
	const aiInstructionFocused = ref(false);
	let aiMenuBlurTimer: ReturnType<typeof setTimeout> | null = null;

	function onAiMenuChange(v: boolean): void {
		if (!v && aiInstructionFocused.value) return;
		aiMenuVisible.value = v;
	}

	function onAiInstructionFocus(): void {
		aiInstructionFocused.value = true;
		if (aiMenuBlurTimer) {
			clearTimeout(aiMenuBlurTimer);
			aiMenuBlurTimer = null;
		}
	}

	function onAiInstructionBlur(): void {
		aiInstructionFocused.value = false;
		// 延迟收起：给「AI执行」按钮留出接收焦点的时间，焦点仍在菜单内则不收
		if (aiMenuBlurTimer) clearTimeout(aiMenuBlurTimer);
		aiMenuBlurTimer = setTimeout(() => {
			if (!aiMenuEl.value?.contains(document.activeElement)) aiMenuVisible.value = false;
		}, 150);
	}
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

	type AiAction = "improve" | "format" | "polish" | "continue" | "custom";

	/** AI 菜单项：图标 + 「AI」前缀文案，一眼可辨 */
	const AI_ACTIONS: Array<{ id: Exclude<AiAction, "custom">; icon: string; label: string }> = [
		{ id: "improve", icon: "material-symbols:auto-fix-high", label: "AI完善内容（全文）" },
		{ id: "format", icon: "material-symbols:format-align-left", label: "AI格式优化（全文）" },
		{ id: "polish", icon: "material-symbols:brush", label: "AI润色（选中文本优先）" },
		{ id: "continue", icon: "material-symbols:edit-note", label: "AI续写（追加文末）" },
	];

	/** AI 处理正文的上限（字符，客户端预检；服务端从磁盘读同一文件） */
	const AI_TEXT_LIMIT = 100_000;

	/** 当前选区（正文字符偏移，升序）；无选区返回 null（CodeMirror 偏移与编辑器正文同坐标系） */
	function selectionRange(): { start: number; end: number } | null {
		const sel = editorRef.value?.getEditorView()?.state.selection.main;
		if (!sel || sel.empty) return null;
		return { start: Math.min(sel.from, sel.to), end: Math.max(sel.from, sel.to) };
	}

	/** 按偏移替换正文片段并选中新文本：AI 运行期间选区会丢失（落盘重置编辑器），不能等结果回来再取现场选区 */
	function replaceRange(start: number, end: number, text: string): void {
		const view = editorRef.value?.getEditorView();
		if (view) {
			const len = view.state.doc.length;
			const s = Math.min(start, len);
			const e = Math.min(end, len);
			view.dispatch({
				changes: { from: s, to: e, insert: text },
				selection: { anchor: s, head: s + text.length },
			});
			return;
		}
		const len = body.value.length;
		body.value = body.value.slice(0, Math.min(start, len)) + text + body.value.slice(Math.min(end, len));
	}

	/** AI 处理正文的统一前置检查：空文/超限提示；通过返回 true */
	function checkAiBody(): boolean {
		if (body.value.trim() === "") {
			ElMessage.warning("正文为空，先写点什么再让 AI 处理");
			return false;
		}
		if (body.value.length > AI_TEXT_LIMIT) {
			ElMessage.warning(`正文超过 ${AI_TEXT_LIMIT} 字符，超出 AI 单次处理上限`);
			return false;
		}
		return true;
	}

	/**
	 * 全文改写类公共流程：先开 diff 弹窗，AI 结果流式刷进右列（节流 200ms），
	 * 完成后启用应用并跳到第一处变更；停止但已有产出时保留查看（不允许应用）。
	 * 只传 postPath 不上送正文，服务端模型经工具自行读取（调用前已静默落盘）。
	 */
	async function runPreviewAction(title: string, instruction: string, maxTokens: number): Promise<void> {
		const original = body.value;
		expandedFolds.value = new Set();
		currentChange.value = 0;
		aiPreview.value = { title, original, result: "", streaming: true, stopped: false };
		let live = "";
		let flushTimer: ReturnType<typeof setTimeout> | null = null;
		const result = await aiConsole.run(`AI${title}`, { instruction, postPath: props.path, maxTokens }, {
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
		if (!checkAiBody()) return;
		// 选区必须最先取：下面的静默落盘会重置编辑器导致选区丢失，选中类任务会退化成全文任务
		const range = selectionRange();
		const selected = (editorRef.value?.getSelectedText() ?? "").trim();
		// 服务端从磁盘读文：先静默落盘，保证模型读到最新正文
		if (!(await autoSaveIfDirty())) return;
		// 收起菜单并把焦点还给编辑器（自定义指令输入框可能仍持有焦点）
		if (aiMenuEl.value?.contains(document.activeElement)) {
			(document.activeElement as HTMLElement).blur();
		}
		aiMenuVisible.value = false;
		// 全走流式控制台：思考/正文实时上屏、可随时停止；null 即停止/失败，原文不动
		let result: string | null = null;

		if (id === "improve" || id === "format") {
			const isImprove = id === "improve";
			const instruction = isImprove
				? "完善这篇 Markdown 文章：补全论述缺口、增强逻辑衔接与技术细节的准确性。表达生动、易读、易懂、有传播力：抽象概念用通俗类比讲清并精确点明核心意义，杜绝大段堆砌文字——长段落拆成短段、列表或表格，关键结论加粗，适合的流程或关系用 mermaid 图（```mermaid 代码围栏）呈现。标题层级统一用 1、1.1、1.1.1 式编号（如 ## 1. 标题、### 1.1 标题），层级与编号严格对应。保留原有观点、语气、代码、图片引用与私有扩展语法（三冒号容器、file-tree 等原样保留）。输出完善后的完整正文。"
				: "优化这篇 Markdown 文章的格式，不改动内容表述：标题层级统一为 1、1.1、1.1.1 式编号（如 ## 1. 标题、### 1.1 标题），层级与编号严格对应；大段文字拆分为短段、列表或表格，关键信息加粗突出；规范列表与引用格式、统一中英文标点与空格、补全代码围栏语言标注、修正排版问题。输出完整正文。";
			await runPreviewAction(isImprove ? "完善内容" : "格式优化", instruction, 16384);
			return;
		}

		if (id === "polish") {
			if (selected !== "" && range) {
				result = await aiConsole.run("AI润色（选中）", {
					instruction:
						"润色用户选中的文字片段（用 read_selection 读取）：表达更流畅自然、生动易读，抽象表述改为通俗说法并精确点明核心意义，保留原意与技术准确性，只输出润色结果。",
					postPath: props.path,
					selectionStart: range.start,
					selectionEnd: range.end,
					maxTokens: 8192,
				});
				if (result !== null) {
					replaceRange(range.start, range.end, result);
					ElMessage.success("已替换选中内容");
				}
			} else {
				await runPreviewAction(
					"润色",
					"润色这篇 Markdown 文章：表达更流畅自然、生动易读、易懂，抽象表述改为通俗说法并精确点明核心意义，避免大段堆砌文字（长段拆短段、列表、关键处加粗），标题层级统一为 1、1.1、1.1.1 式编号；保留原意、代码与私有扩展语法，输出完整正文。",
					16384,
				);
			}
			return;
		}

		if (id === "continue") {
			result = await aiConsole.run("AI续写", {
				instruction:
					"续写这篇目标文章：先读原文（结尾部分必读），从当前结尾自然延续，保持语气、人称与 Markdown 格式一致，延续正文的标题编号体系（1、1.1、1.1.1 式）与生动易读的风格（短段、列表、关键处加粗，忌大段堆砌文字），只输出续写的新内容，不要重复已有内容。",
				postPath: props.path,
				maxTokens: 8192,
			});
			if (result !== null) {
				body.value = `${body.value.replace(/\s+$/, "")}\n\n${result}\n`;
				ElMessage.success("已追加到文末");
			}
			return;
		}

		// 自定义指令：有选中作用于选中，无选中作用于全文（预览后应用）；执行成功后清空输入
		const instruction = aiCustomInstruction.value.trim();
		if (instruction === "") return;
		if (selected !== "" && range) {
			result = await aiConsole.run("AI自定义指令（选中）", {
				instruction: `${instruction}（作用于用户选中的文字片段，用 read_selection 读取原文，只输出处理结果）`,
				postPath: props.path,
				selectionStart: range.start,
				selectionEnd: range.end,
				maxTokens: 8192,
			});
			if (result !== null) {
				replaceRange(range.start, range.end, result);
				ElMessage.success("已替换选中内容");
				aiCustomInstruction.value = "";
			}
		} else {
			await runPreviewAction("自定义指令", instruction, 16384);
			if (aiConsole.lastOutcome === "done") aiCustomInstruction.value = "";
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

	/** 抽屉内静默生成（不弹 AI 面板）：标签/摘要按钮的 loading 态 */
	const drawerAiBusy = ref<"tags" | "summary" | null>(null);

	/** 静默任务失败/停止的轻提示（面板未弹出，详情在 AI 助手里查看） */
	function notifySilentFailure(): void {
		if (aiConsole.lastOutcome === "error") ElMessage.error("AI 生成失败，可打开 AI 助手查看详情");
		else if (aiConsole.lastOutcome === "stopped") ElMessage.info("已停止生成");
	}

	/** AI 生成摘要回填文章信息（编辑器工具栏与信息抽屉共用）；静默执行不弹 AI 面板，返回是否成功回填 */
	async function aiGenerateSummary(): Promise<boolean> {
		if (!checkAiBody()) return false;
		// 服务端从磁盘读文：先静默落盘
		if (!(await autoSaveIfDirty())) return false;
		drawerAiBusy.value = "summary";
		try {
			const result = await aiConsole.run(
				"AI生成摘要",
				{
					instruction:
						"为这篇目标文章生成 80-160 字的中文摘要：概括主题与关键要点，客观陈述，只输出摘要本身。",
					postPath: props.path,
					maxTokens: 1024,
				},
				{ silent: true },
			);
			if (result === null) {
				notifySilentFailure();
				return false;
			}
			if (description.value.trim() !== "") {
				try {
					await ElMessageBox.confirm("文章信息中的摘要已有内容，覆盖为 AI 摘要？", "生成摘要", {
						type: "warning",
						confirmButtonText: "覆盖",
						cancelButtonText: "取消",
					});
				} catch {
					return false; // 用户取消
				}
			}
			description.value = result;
			ElMessage.success("摘要已回填文章信息");
			return true;
		} finally {
			drawerAiBusy.value = null;
		}
	}

	/** AI 生成标签回填文章信息：静默执行不弹 AI 面板；先匹配全站现有标签，不足以概括时才新增；已有标签需确认覆盖 */
	async function aiGenerateTags(): Promise<void> {
		if (!checkAiBody()) return;
		// 服务端从磁盘读文：先静默落盘
		if (!(await autoSaveIfDirty())) return;
		const pool = tagOptions.value.map((t) => t.name);
		const poolNote =
			pool.length > 0
				? `全站现有标签：${pool.join("、")}。优先从中挑选贴合本文的（保持标签体系一致、避免同义重复），仅当现有标签不足以概括本文时才新增。`
				: "全站暂无标签，直接新建。";
		drawerAiBusy.value = "tags";
		try {
			const result = await aiConsole.run(
				"AI生成标签",
				{
					instruction: `为这篇目标文章（原文自行读取）生成 3-6 个标签。${poolNote}中文为主，通用技术名词可用英文（如 TypeScript）。只输出标签本身，用逗号分隔，不要编号、引号或解释。`,
					postPath: props.path,
					maxTokens: 512,
				},
				{ silent: true },
			);
			if (result === null) {
				notifySilentFailure();
				return;
			}
			const parsed = [
				...new Set(
					result
						.split(/[\n,，、;；]/)
						.map((t) =>
							t
								.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, "")
								.replace(/^["'「]|["'」]$/g, "")
								.trim(),
						)
						.filter((t) => t !== ""),
				),
			];
			if (parsed.length === 0) {
				ElMessage.warning("AI 未返回有效标签");
				return;
			}
			if (tags.value.length > 0) {
				try {
					await ElMessageBox.confirm(`标签已有内容，覆盖为 AI 生成的 ${parsed.length} 个标签？`, "生成标签", {
						type: "warning",
						confirmButtonText: "覆盖",
						cancelButtonText: "取消",
					});
				} catch {
					return; // 用户取消
				}
			}
			tags.value = parsed;
			ElMessage.success("标签已回填文章信息");
		} finally {
			drawerAiBusy.value = null;
		}
	}

	/** 封面自动生成＝取正文第一张图（Markdown 或 HTML img），没有就留空 */
	async function autoPickCover(): Promise<void> {
		const src =
			body.value.match(/!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/)?.[1] ??
			body.value.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] ??
			"";
		if (src === "") {
			ElMessage.warning("正文中没有图片，封面留空");
			return;
		}
		if (image.value.trim() !== "" && image.value.trim() !== src) {
			try {
				await ElMessageBox.confirm("封面已设置，替换为正文第一张图片？", "自动封面", {
					type: "warning",
					confirmButtonText: "替换",
					cancelButtonText: "取消",
				});
			} catch {
				return; // 用户取消
			}
		}
		image.value = src;
		ElMessage.success("封面已取正文第一张图片");
	}

	function fill(p: PostFile): void {
		post.value = p;
		slug.value = p.meta.slug;
		title.value = p.meta.title;
		publishedAt.value = mergePublished(p.meta.published, p.meta.publishedAt);
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

	/** 读取时合并：published 日期 + publishedAt 时间（缺省 00:00:00）→ 单一「发布日期」字段 */
	function mergePublished(date: string, at?: string): string {
		const t = at?.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);
		return `${date.slice(0, 10)}T${t?.[1] ?? "00"}:${t?.[2] ?? "00"}:${t?.[3] ?? "00"}`;
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
			const titleBefore = title.value;
			const result = await postApi.save({
				path: props.path,
				body: body.value,
				password: password.value || undefined,
				clearPassword: !encrypted.value,
				meta: {
					title: title.value,
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
					updated: filled.meta.updated ?? "",
					updatedAt: filled.meta.updatedAt ?? "",
				},
			});
			// —— 保存回填的输入保护：自动保存对打字中的用户必须无感 ——
			// 对编辑器 v-model 赋不同的值＝整篇替换文档，光标会跳回开头（旧做法先 fill 再改回，
			// 编辑器已被重置两次，光标照样丢）。因此正文/标题/信息抽屉字段一律不回写，只同步基线与只读元信息：
			// - 请求期间用户继续输入 → 基线记磁盘版本，isDirty 保持为真，下一轮自动保存补落盘；
			// - 服务端序列化只 trim 正文首尾空白 → 基线取编辑器现值，避免下一轮假“脏”反复保存。
			const bodyTyped = body.value !== bodyBefore;
			const titleTyped = title.value !== titleBefore;
			if (!bodyTyped && bodyBefore.trim() !== result.body.trim()) {
				// 防御：服务端实质改动了正文（当前实现只会 trim，理论不可达）才以磁盘版本为准
				body.value = result.body;
			}
			post.value = {
				...result,
				body: bodyTyped ? result.body : body.value,
				meta: { ...result.meta, title: titleTyped ? result.meta.title : title.value },
			};
			slug.value = result.meta.slug;
			publishedAt.value = mergePublished(result.meta.published, result.meta.publishedAt);
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

	/** 发布＝保存并落盘 draft=false 后返回列表：仅维护本地状态，站点上线发生在代码推送之后 */
	async function saveAndPublish(): Promise<void> {
		const wasDraft = draft.value;
		draft.value = false;
		if (!(await save(true))) {
			draft.value = wasDraft;
			return;
		}
		ElMessage.success("已标记发布，推送代码后上线");
		emit("back");
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
			callback(results.map((r) => ({ url: r.src, alt: r.alt ?? "", title: "" })));
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
			<el-button-group>
				<el-button @click="drawerVisible = true">
					<el-icon><InfoFilled /></el-icon>文章信息
				</el-button>
				<el-button type="danger" @click="remove">删除</el-button>
				<el-button type="primary" :loading="saving" @click="save()">保存</el-button>
				<el-button type="success" :loading="saving" @click="saveAndPublish">发布</el-button>
			</el-button-group>
			<span v-if="lastAutoSavedAt" class="auto-save-hint">已自动保存 {{ lastAutoSavedAt }}</span>
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
				:theme="isDark ? 'dark' : 'light'"
				:sanitize="editorSanitize"
				placeholder="正文使用标准 Markdown 语法"
				@on-upload-img="onUploadImg"
			>
				<!-- 自定义工具：overlay 渲染在编辑器 DOM 内，只放原生元素避免弹层冲突。
				    数字槽位 = 本模板内第 N 个实际渲染的子组件：AI 下拉（启用时），分栏编辑排最右 -->
				<template #defToolbars>
					<DropdownToolbar
						v-if="aiOn"
						:visible="aiMenuVisible"
						title="AI 助手"
						@on-change="onAiMenuChange"
					>
						<template #trigger>
							<span class="ai-toolbar-trigger" :class="{ 'is-busy': aiRunning }">
								<el-icon v-if="aiRunning" class="is-loading"><Loading /></el-icon>
								<Icon v-else icon="material-symbols:auto-awesome" />
								<em class="ai-toolbar-text">AI</em>
							</span>
						</template>
						<template #overlay>
							<div ref="aiMenuEl" class="ai-toolbar-menu">
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
										@focus="onAiInstructionFocus"
										@blur="onAiInstructionBlur"
										@keydown.esc="aiMenuVisible = false"
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
					<!-- 分栏编辑：跳转完整编辑页（左右分栏预览），工具栏最右 -->
					<NormalToolbar v-if="expandable" title="分栏编辑（左右分栏预览）" @onClick="expand">
						<Icon icon="material-symbols:vertical-split" class="split-toolbar-icon" />
					</NormalToolbar>
				</template>
			</MdEditor>
		</div>

		<el-drawer v-model="drawerVisible" title="文章信息" size="480px">
			<el-form label-position="top" class="drawer-form">
				<el-form-item label="发布日期">
					<div class="published-ro">
						<el-icon><Icon icon="material-symbols:calendar-month" /></el-icon>
						<span>{{ publishedDisplay }}</span>
					</div>
				</el-form-item>
				<el-form-item label="分类">
					<el-select
						v-model="category"
						filterable
						allow-create
						default-first-option
						clearable
						placeholder="选择已有分类，或输入新建"
						style="width: 100%"
					>
						<el-option v-for="c in categoryOptions" :key="c.name" :value="c.name" :label="c.name">
							<span>{{ c.name }}</span>
							<span class="opt-count">{{ c.n }} 篇</span>
						</el-option>
					</el-select>
				</el-form-item>
				<el-form-item>
					<template #label>
						<span class="label-row">
							标签
							<button
								v-if="aiOn"
								type="button"
								class="ai-gen-btn"
								:disabled="aiRunning"
								@click="aiGenerateTags"
							>
								<el-icon v-if="drawerAiBusy === 'tags'" class="is-loading"><Loading /></el-icon>
								<el-icon v-else><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 生成
							</button>
						</span>
					</template>
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
				<el-form-item>
					<template #label>
						<span class="label-row">
							摘要
							<button
								v-if="aiOn"
								type="button"
								class="ai-gen-btn"
								:disabled="aiRunning"
								@click="aiGenerateSummary"
							>
								<el-icon v-if="drawerAiBusy === 'summary'" class="is-loading"><Loading /></el-icon>
								<el-icon v-else><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 生成
							</button>
						</span>
					</template>
					<el-input v-model="description" type="textarea" :rows="2" placeholder="留空自动截取正文前段" />
				</el-form-item>
				<el-form-item>
					<template #label>
						<span class="label-row">
							封面
							<button type="button" class="ai-gen-btn" @click="autoPickCover">
								<el-icon><Icon icon="material-symbols:image-search" /></el-icon>取正文首图
							</button>
						</span>
					</template>
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
					<div v-if="coverPreview" class="cover-preview">
						<img :src="coverPreview" alt="封面预览" />
					</div>
				</el-form-item>

				<div class="drawer-divider" />

				<div class="switch-row">
					<span class="switch-label">
						<el-icon><Icon icon="material-symbols:forum-outline" /></el-icon>允许评论
					</span>
					<el-switch v-model="comment" />
				</div>

				<div class="encrypt-card" :class="{ 'is-on': encrypted }">
					<div class="switch-row head">
						<span class="switch-label">
							<el-icon><Icon icon="material-symbols:lock" /></el-icon>加密访问
						</span>
						<el-switch v-model="encrypted" />
					</div>
					<template v-if="encrypted">
						<el-input
							v-model="password"
							show-password
							clearable
							:placeholder="post?.meta.hasPassword ? '已设置，输入则修改' : '设置访问密码'"
						/>
						<el-input v-model="passwordHint" placeholder="密码提示（公开可见）" />
						<div class="switch-row sub">
							<span class="switch-label">首页卡片隐藏预览</span>
							<el-switch v-model="hideHomeContent" />
						</div>
					</template>
				</div>
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
		font-size: calc(20px + var(--font-shift, 0px));
		font-weight: 600;
		padding: 4px 14px;
	}
	.editor-wrap {
		flex: 1;
		min-height: 0;
	}
	.editor-wrap :deep(.md-editor) {
		--md-bk-color: var(--el-bg-color);
		height: 100%;
		border-radius: 8px;
		border: 1px solid var(--el-border-color-lighter);
	}
	/* 正文 ≥ 20px：编辑器源码区（CodeMirror 正文）与预览区文字同步抬高 */
	.editor-wrap :deep(.cm-content),
	.editor-wrap :deep(.md-editor-preview) {
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.drawer-form :deep(.el-form-item) {
		margin-bottom: 16px;
	}
	.drawer-form :deep(.el-form-item__label) {
		font-weight: 600;
		margin-bottom: 4px;
	}
	/* 发布日期只读胶囊（后端发布时盖戳） */
	.published-ro {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		height: 36px;
		padding: 0 14px;
		border-radius: 8px;
		background: var(--el-fill-color-light);
		color: var(--el-text-color-regular);
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.published-ro .el-icon {
		color: var(--el-color-primary);
		font-size: calc(18px + var(--font-shift, 0px));
	}
	/* 分隔线：内容字段与下方开关区 */
	.drawer-divider {
		height: 1px;
		background: var(--el-border-color-lighter);
		margin: 4px 0 12px;
	}
	/* 开关行：左说明右开关 */
	.switch-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 6px 2px 14px;
	}
	.switch-label {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: calc(20px + var(--font-shift, 0px));
	}
	.switch-label .el-icon {
		color: var(--el-text-color-secondary);
		font-size: calc(18px + var(--font-shift, 0px));
	}
	/* 加密卡片：单独处置，开启时暖色提示并展开密码区 */
	.encrypt-card {
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 10px;
		padding: 8px 14px 2px;
		transition:
			border-color 0.2s,
			background-color 0.2s;
	}
	.encrypt-card.is-on {
		border-color: rgb(230 162 60 / 55%);
		background: rgb(230 162 60 / 6%);
	}
	.encrypt-card .switch-row {
		padding: 6px 0 10px;
	}
	.encrypt-card .switch-row.sub {
		padding: 2px 0 10px;
	}
	.encrypt-card .switch-row.sub .switch-label {
		color: var(--el-text-color-secondary);
	}
	.encrypt-card .el-input {
		margin-bottom: 12px;
	}
	/* 封面预览缩略图 */
	.cover-preview {
		margin-top: 8px;
		border: 1px solid var(--el-border-color-lighter);
		border-radius: 8px;
		overflow: hidden;
	}
	.cover-preview img {
		display: block;
		width: 100%;
		max-height: 150px;
		object-fit: cover;
	}
	.cover-upload {
		cursor: pointer;
	}
	/* 表单标签行：字段名 + 紧凑实心生成按钮（白字高对比，与字段名留出间距） */
	.label-row {
		display: inline-flex;
		align-items: center;
		gap: 12px;
	}
	.ai-gen-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		height: 26px;
		padding: 0 12px;
		border: none;
		border-radius: 6px;
		background: var(--el-color-primary);
		color: #fff;
		font-size: calc(16px + var(--font-shift, 0px));
		font-family: inherit;
		line-height: 1;
		cursor: pointer;
	}
	.ai-gen-btn .el-icon {
		font-size: calc(14px + var(--font-shift, 0px));
	}
	.ai-gen-btn:hover:not(:disabled) {
		background: var(--el-color-primary-light-3);
	}
	.ai-gen-btn:disabled {
		opacity: 0.55;
		cursor: not-allowed;
	}
	/* 下拉候选项右侧的使用次数 */
	.opt-count {
		float: right;
		color: var(--el-text-color-secondary);
		font-size: calc(16px + var(--font-shift, 0px));
	}
	/* 分栏编辑工具按钮：图标尺寸与内置工具位对齐 */
	.split-toolbar-icon {
		font-size: 20px;
	}
	/* AI 工具栏触发器：图标 + 「AI」文字（区别于纯图标工具，一眼可辨） */
	.ai-toolbar-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: 24px;
		padding: 0 5px;
		font-size: calc(18px + var(--font-shift, 0px));
		color: inherit;
	}
	.ai-toolbar-text {
		font-style: normal;
		font-size: calc(12px + var(--font-shift, 0px));
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
		font-size: calc(20px + var(--font-shift, 0px));
		border-radius: 6px;
		cursor: pointer;
		color: inherit;
	}
	.ai-toolbar-menu button .el-icon {
		font-size: calc(16px + var(--font-shift, 0px));
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
		font-size: calc(14px + var(--font-shift, 0px));
	}
	.ai-toolbar-custom input {
		flex: 1;
		min-width: 0;
		border: 1px solid rgba(128, 128, 128, 0.35);
		border-radius: 6px;
		padding: 5px 8px;
		font-size: calc(20px + var(--font-shift, 0px));
		background: transparent;
		color: inherit;
		outline: none;
	}
	.ai-length-warn {
		color: var(--el-color-danger);
		font-size: calc(20px + var(--font-shift, 0px));
		margin-bottom: 8px;
	}
	/* 顶栏自动保存时间提示 */
	.auto-save-hint {
		font-size: calc(16px + var(--font-shift, 0px));
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
		font-size: calc(16px + var(--font-shift, 0px));
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
		font-size: calc(20px + var(--font-shift, 0px));
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
		font-size: calc(20px + var(--font-shift, 0px));
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
		font-size: calc(11px + var(--font-shift, 0px));
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
		font-size: calc(20px + var(--font-shift, 0px));
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
		background: var(--el-color-danger-light-9);
		border-radius: 2px;
	}
	.seg.ins {
		background: var(--el-color-success-light-9);
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
		font-size: calc(20px + var(--font-shift, 0px));
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
