import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { streamChat, streamEdit, type StreamEditInput, type StreamEditResult } from "../api/stream";

/**
 * AI 流式任务引擎（全局单任务）：没有统一控制台，各使用点就地展示——
 * 编辑器 diff 弹窗（状态条 + 继续调整输入）、说说/表单按钮流式回填等。
 * 这里只管执行与状态：运行中/耗时/思考流/结局，以及「结果弹窗迭代」的追问分流。
 * 上下文由服务端会话持有：任务首轮建立 sessionId，结果弹窗追问复用（不重传历史）。
 */

/** 思考流滚动保留上限：超出掐头续尾，防长思考撑爆展示区 */
const THINKING_CAP = 8000;

/** 结果弹窗迭代：任务成功且弹窗未关时由弹窗持有方注册，之后追问流式更新弹窗右列 */
export interface AiResultIteration {
	/** 一轮迭代开始：弹窗切回流式态（禁用应用、重置折叠导航） */
	onStart(): void;
	/** 流式累计全文（节流由接收方负责） */
	onText(full: string): void;
	/** 成功：全文落定，弹窗恢复可应用 */
	onDone(full: string): void;
	/** 停止/失败收尾：停止且已有部分产出时接收方可保留查看 */
	onEnd(outcome: "stopped" | "error"): void;
}

export const useAiConsoleStore = defineStore("aiConsole", () => {
	const running = ref(false);
	/** 当前轮耗时（秒级跳动，弹窗状态条显示）；结束停在本轮最终值 */
	const elapsedMs = ref(0);
	/** 当前轮思考流（滚动截断），就地展示 */
	const thinking = ref("");
	/** 当前会话 ID（服务端持有上下文）：任务首轮建立，结果弹窗追问复用 */
	const sessionId = ref<string | null>(null);
	/** 最近一轮结局与错误信息 */
	const lastOutcome = ref<"done" | "stopped" | "error" | null>(null);
	const lastError = ref("");
	/** 结果弹窗迭代挂钩：注册期间追问改走「更新弹窗」；新任务即失效 */
	const iteration = ref<AiResultIteration | null>(null);
	const iterating = computed(() => iteration.value !== null);

	let controller: AbortController | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let startedAt = 0;

	function stopTimer(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	/** 开启一轮：重置状态、起表 */
	function beginRound(): void {
		running.value = true;
		thinking.value = "";
		elapsedMs.value = 0;
		lastOutcome.value = null;
		lastError.value = "";
		controller = new AbortController();
		startedAt = Date.now();
		stopTimer();
		timer = setInterval(() => {
			elapsedMs.value = Date.now() - startedAt;
		}, 1000);
	}

	function finishRound(outcome: "done" | "stopped" | "error"): void {
		running.value = false;
		stopTimer();
		elapsedMs.value = Date.now() - startedAt;
		lastOutcome.value = outcome;
		controller = null;
	}

	function appendThinking(text: string): void {
		thinking.value += text;
		if (thinking.value.length > THINKING_CAP) {
			thinking.value = `…（已截断）\n${thinking.value.slice(-THINKING_CAP)}`;
		}
	}

	/** 流式轮公共执行：onText 回调累计全文；成功登记会话，返回全文；停止/失败返回 null（结局落在 lastOutcome/lastError） */
	async function runRound(
		exec: (
			handlers: { onThinking(text: string): void; onText(text: string): void },
			signal: AbortSignal,
		) => Promise<StreamEditResult>,
		onText?: (full: string) => void,
	): Promise<string | null> {
		let acc = "";
		try {
			const result = await exec(
				{
					onThinking: appendThinking,
					onText: (text) => {
						acc += text;
						onText?.(acc);
					},
				},
				controller?.signal as AbortSignal,
			);
			if (result.sessionId) sessionId.value = result.sessionId;
			finishRound("done");
			return result.content.trim();
		} catch (e) {
			if ((e as Error).name === "AbortError") finishRound("stopped");
			else {
				lastError.value = (e as Error).message;
				finishRound("error");
			}
			return null;
		}
	}

	/**
	 * 任务入口：开新会话流式执行；完成返回 trim 后全文，停止/失败返回 null。
	 * onText 每次收到增量后回调「累计全文」，供调用方流式回填（节流由调用方负责）。
	 * 会话更换，旧弹窗迭代挂钩一并失效。
	 */
	async function run(input: StreamEditInput, opts?: { onText?: (full: string) => void }): Promise<string | null> {
		if (running.value) {
			ElMessage.warning("已有 AI 任务进行中，请先停止或等待完成");
			return null;
		}
		sessionId.value = null;
		iteration.value = null;
		beginRound();
		return runRound((handlers, signal) => streamEdit(input, handlers, signal), opts?.onText);
	}

	/** 结果弹窗迭代追问：续任务会话，正文流式更新弹窗；无挂钩（弹窗已关）时提示并拒绝 */
	async function send(text: string): Promise<string | null> {
		const question = text.trim();
		if (question === "") return null;
		if (running.value) {
			ElMessage.warning("已有 AI 任务进行中，请先停止或等待完成");
			return null;
		}
		const hooks = iteration.value;
		if (!hooks) {
			ElMessage.warning("「AI 结果」弹窗已关闭，无法继续调整");
			return null;
		}
		// 会话里已有上一轮全文，明确要求输出修改后的完整正文（弹窗 diff 基线是最初原文，需整篇更新右列）
		const message = `${question}\n\n（请基于上一轮结果继续修改，输出修改后的完整正文；不要任何解释、前后缀或代码围栏。）`;
		beginRound();
		hooks.onStart();
		const result = await runRound((handlers, signal) =>
			streamChat({ sessionId: sessionId.value ?? undefined, message, maxTokens: 16384 }, handlers, signal),
		);
		if (result !== null) hooks.onDone(result);
		else hooks.onEnd(lastOutcome.value === "stopped" ? "stopped" : "error");
		return result;
	}

	function stop(): void {
		controller?.abort();
	}

	/** 上一轮失败/停止的轻提示（停止已由界面状态表达，只提示失败详情） */
	function reportOutcome(): void {
		if (lastOutcome.value === "error") ElMessage.error(`AI 生成失败：${lastError.value}`);
	}

	function attachIteration(hooks: AiResultIteration): void {
		iteration.value = hooks;
	}

	/** 身份校验摘除：只摘自己注册的，避免误摘其他编辑器实例后注册的挂钩 */
	function detachIteration(hooks: AiResultIteration): void {
		if (iteration.value === hooks) iteration.value = null;
	}

	return {
		running,
		elapsedMs,
		thinking,
		sessionId,
		lastOutcome,
		lastError,
		iterating,
		run,
		send,
		stop,
		reportOutcome,
		attachIteration,
		detachIteration,
	};
});
