import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { streamChat, streamEdit, type StreamEditInput } from "../api/stream";

/**
 * AI 流式控制台：全局唯一，兼具两种形态——
 * 任务（run）：编辑器/说说等写作入口，开场即清空旧对话，完成把全文返回调用方；
 * 对话（send）：任务结束后或随时打开，多轮追问，历史在本地拼接后整段上送。
 */

/** 单条思考流滚动保留上限：超出掐头续尾，防长思考撑爆 DOM */
const THINKING_CAP = 8000;
/** 追问上送的历史预算（字符）：超预算从最旧的消息开始丢弃，最近的上下文始终保留 */
const HISTORY_BUDGET = 60_000;

export interface AiConsoleEntry {
	id: number;
	role: "user" | "assistant";
	/** 展示内容：任务条目 = 任务名，聊天 = 输入原文 */
	content: string;
	/** 实际发给模型的内容（任务 = 指令 + 全文）；缺省用 content */
	send?: string;
	/* ---------- assistant 专属 ---------- */
	thinking?: string;
	thinkingOpen?: boolean;
	stopped?: boolean;
	error?: string;
	model?: string;
	elapsedMs?: number;
}

/** 对话默认 system：通用博客写作/内容管理助手 */
const CHAT_SYSTEM =
	"你是博客管理工具内置的 AI 助手，擅长 Markdown 写作、中文表达润色与博客内容管理问答。回答简洁准确，默认使用中文；涉及改写建议时给出可直接使用的文本。";

export const useAiConsoleStore = defineStore("aiConsole", () => {
	const visible = ref(false);
	const entries = ref<AiConsoleEntry[]>([]);
	const running = ref(false);
	/** 当前流式任务的耗时（头部实时跳动），结束时落到对应条目上 */
	const elapsedMs = ref(0);
	const draft = ref("");
	/** 任务结束后自动收起成标题条，避免悬浮面板挡住下面的页面操作；点标题条展开回看 */
	const collapsed = ref(false);

	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let startedAt = 0;
	let entrySeq = 0;

	const lastAssistant = computed(() =>
		[...entries.value].reverse().find((e) => e.role === "assistant"),
	);

	/** 最近一次流的结局：任务调用方（如 diff 弹窗）据此决定如何收尾 */
	const lastOutcome = computed<"done" | "stopped" | "error" | null>(() => {
		const last = lastAssistant.value;
		if (!last || !last.elapsedMs) return null;
		if (last.error) return "error";
		if (last.stopped) return "stopped";
		return "done";
	});

	const statusLabel = computed(() => {
		if (running.value) return lastAssistant.value?.content === "" ? "思考中" : "生成中";
		const last = lastAssistant.value;
		if (!last) return entries.value.length === 0 ? "空闲" : "已完成";
		if (last.error) return "失败";
		if (last.stopped) return "已停止";
		if (last.content !== "") return "已完成";
		return "空闲";
	});

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	function appendUser(display: string, send?: string): AiConsoleEntry {
		const entry: AiConsoleEntry = { id: (entrySeq += 1), role: "user", content: display, send };
		entries.value.push(entry);
		return entry;
	}

	function appendAssistant(): AiConsoleEntry {
		const entry: AiConsoleEntry = {
			id: (entrySeq += 1),
			role: "assistant",
			content: "",
			thinking: "",
			thinkingOpen: true,
		};
		entries.value.push(entry);
		return entry;
	}

	/** 流式公共收尾：置停/错误标记、停表；返回是否拿到非空全文 */
	function wireStream(
		entry: AiConsoleEntry,
		onText?: (full: string) => void,
	): { onThinking(text: string): void; onText(text: string): void } {
		return {
			onThinking: (text) => {
				entry.thinking = (entry.thinking ?? "") + text;
				if (entry.thinking.length > THINKING_CAP) {
					entry.thinking = `…（已截断）\n${entry.thinking.slice(-THINKING_CAP)}`;
				}
			},
			onText: (text) => {
				entry.content += text;
				onText?.(entry.content);
			},
		};
	}

	function finishStream(entry: AiConsoleEntry, autoCollapse: boolean): void {
		running.value = false;
		stopTimer();
		entry.elapsedMs = Date.now() - startedAt;
		elapsedMs.value = entry.elapsedMs;
		controller = null;
		// 任务结束（含停止/失败）即收起成标题条：结果已回传调用方，别挡页面；
		// 聊天追问不收起——用户正盯着对话
		if (autoCollapse) collapsed.value = true;
	}

	/**
	 * 任务入口：清空旧对话、打开面板并流式执行；完成返回 trim 后全文，停止/失败返回 null。
	 * onText 每次收到增量后回调「累计全文」，供调用方做流式 diff 等实时展示（节流由调用方负责）。
	 */
	async function run(
		runTitle: string,
		input: StreamEditInput,
		opts?: { onText?: (full: string) => void },
	): Promise<string | null> {
		if (running.value) {
			ElMessage.warning("已有 AI 任务进行中，请先停止或等待完成");
			return null;
		}
		// 任务即新对话：不携带上一个任务的上下文
		entries.value = [];
		appendUser(runTitle, `指令：${input.instruction}\n\n文本：\n${input.text}`);
		const entry = appendAssistant();
		visible.value = true;
		collapsed.value = false;
		running.value = true;
		controller = new AbortController();
		startedAt = Date.now();
		elapsedMs.value = 0;
		stopTimer();
		timer = setInterval(() => {
			elapsedMs.value = Date.now() - startedAt;
		}, 1000);
		try {
			const result = await streamEdit(input, wireStream(entry, opts?.onText), controller.signal);
			entry.model = result.model ?? "";
			return result.content.trim();
		} catch (e) {
			if ((e as Error).name === "AbortError") entry.stopped = true;
			else entry.error = (e as Error).message;
			return null;
		} finally {
			finishStream(entry, true);
		}
	}

	/** 对话入口：携带此前任务/对话的历史，流式回答；返回全文或 null（停止/失败） */
	async function send(text: string): Promise<string | null> {
		const question = text.trim();
		if (question === "") return null;
		if (running.value) {
			ElMessage.warning("已有 AI 任务进行中，请先停止或等待完成");
			return null;
		}
		draft.value = "";
		appendUser(question);
		const entry = appendAssistant();
		visible.value = true;
		collapsed.value = false;
		running.value = true;
		controller = new AbortController();
		startedAt = Date.now();
		elapsedMs.value = 0;
		stopTimer();
		timer = setInterval(() => {
			elapsedMs.value = Date.now() - startedAt;
		}, 1000);
		try {
			const result = await streamChat(
				{ messages: buildHistory(), system: CHAT_SYSTEM },
				wireStream(entry),
				controller.signal,
			);
			entry.model = result.model ?? "";
			return result.content.trim();
		} catch (e) {
			if ((e as Error).name === "AbortError") entry.stopped = true;
			else entry.error = (e as Error).message;
			return null;
		} finally {
			finishStream(entry, false);
		}
	}

	/** 从最新往回收历史：超预算即截断最旧部分（任务首条常是整篇全文，最占预算） */
	function buildHistory(): Array<{ role: "user" | "assistant"; content: string }> {
		const picked: Array<{ role: "user" | "assistant"; content: string }> = [];
		let total = CHAT_SYSTEM.length;
		for (let i = entries.value.length - 1; i >= 0; i -= 1) {
			const e = entries.value[i];
			if (e.role === "assistant" && (e.content === "" || e.error)) continue;
			const content = e.role === "user" ? (e.send ?? e.content) : e.content;
			total += content.length;
			if (total > HISTORY_BUDGET && picked.length > 0) break;
			picked.unshift({ role: e.role, content });
		}
		return picked;
	}

	function stop(): void {
		controller?.abort();
	}

	/** 新对话：清空消息与输入（运行中先停止） */
	function newTalk(): void {
		if (running.value) stop();
		entries.value = [];
		draft.value = "";
		collapsed.value = false;
	}

	function close(): void {
		if (running.value) stop();
		visible.value = false;
	}

	function toggle(): void {
		visible.value = !visible.value;
		if (visible.value) collapsed.value = false;
	}

	function toggleCollapsed(): void {
		collapsed.value = !collapsed.value;
	}

	function toggleEntryThinking(id: number): void {
		const e = entries.value.find((item) => item.id === id);
		if (e) e.thinkingOpen = !e.thinkingOpen;
	}

	return {
		visible,
		entries,
		running,
		elapsedMs,
		draft,
		collapsed,
		lastOutcome,
		statusLabel,
		run,
		send,
		stop,
		newTalk,
		close,
		toggle,
		toggleCollapsed,
		toggleEntryThinking,
	};
});
