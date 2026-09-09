import { ApiError } from "./client";

export interface StreamEditInput {
	instruction: string;
	text: string;
	maxTokens?: number;
}

/** chat-stream 的多轮对话输入（system 独立传，messages 只含 user/assistant） */
export interface StreamChatInput {
	messages: Array<{ role: "user" | "assistant"; content: string }>;
	system?: string;
	maxTokens?: number;
}

export interface StreamHandlers {
	onThinking?(text: string): void;
	onText?(text: string): void;
}

export interface StreamEditResult {
	content: string;
	model?: string;
	completionTokens?: number;
}

/**
 * 流式 AI 接口（edit-stream / chat-stream 共用）：原生 fetch 消费 SSE。
 * 不走 client.ts 的 JSON 封装（那是整包读取）；停止由调用方 abort signal 触发，
 * AbortError 原样抛出，由上层定性（用户停止 ≠ 失败）。
 */
async function consumeSse(res: Response, handlers: StreamHandlers): Promise<StreamEditResult> {
	if (!res.ok) {
		let message = `请求失败（HTTP ${res.status}）`;
		try {
			const data = JSON.parse(await res.text()) as { message?: string };
			if (data.message) message = data.message;
		} catch {
			// 保持默认消息
		}
		throw new ApiError(res.status, message);
	}
	if (!res.body) throw new ApiError(502, "当前浏览器不支持流式读取");

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	// holder 对象规避 TS 闭包 narrowing（同仓库既有惯例）
	const state = { result: null as StreamEditResult | null };
	let buffer = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep >= 0) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const line = frame.split("\n").find((l) => l.startsWith("data:"));
				if (line) {
					const payload = line.slice(5).trim();
					if (payload !== "") handleFrame(payload);
				}
				sep = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (!state.result) throw new ApiError(502, "AI 连接中断：未收到完成信号");
	return state.result;

	function handleFrame(payload: string): void {
		const evt = JSON.parse(payload) as {
			type: string;
			text?: string;
			content?: string;
			model?: string;
			completionTokens?: number;
			message?: string;
		};
		if (evt.type === "thinking" && evt.text) handlers.onThinking?.(evt.text);
		else if (evt.type === "text" && evt.text) handlers.onText?.(evt.text);
		else if (evt.type === "done") {
			state.result = { content: evt.content ?? "", model: evt.model, completionTokens: evt.completionTokens };
		} else if (evt.type === "error") {
			throw new ApiError(502, evt.message ?? "AI 流式调用失败");
		}
	}
}

/** 流式改写：指令 + 文本 → 增量回调 */
export function streamEdit(
	input: StreamEditInput,
	handlers: StreamHandlers,
	signal: AbortSignal,
): Promise<StreamEditResult> {
	return postStream("/api/ai/edit-stream", input, handlers, signal);
}

/** 流式多轮对话：完整历史一次带上，追问上下文在服务端由模型自行衔接 */
export function streamChat(
	input: StreamChatInput,
	handlers: StreamHandlers,
	signal: AbortSignal,
): Promise<StreamEditResult> {
	return postStream("/api/ai/chat-stream", input, handlers, signal);
}

async function postStream(
	endpoint: string,
	body: StreamEditInput | StreamChatInput,
	handlers: StreamHandlers,
	signal: AbortSignal,
): Promise<StreamEditResult> {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	return consumeSse(res, handlers);
}
