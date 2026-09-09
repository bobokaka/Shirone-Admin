import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
	AiChatMessage,
	AiChatResult,
	AiProtocol,
	AiProviderConfig,
	AiSettings,
} from "@shirone-admin/shared";
import { ADMIN_DATA_DIR } from "../config.js";
import { ApiError } from "../lib/errors.js";

/**
 * AI 助手设置与模型代理调用（Anthropic 兼容 v1/messages / OpenAI 兼容 chat/completions）。
 * 支持保存多套服务商配置并随时切换生效。
 * 设置保存在 server/data/ai-settings.json（gitignore），API Key 绝不落入内容仓。
 */

const SETTINGS_FILE = path.join(ADMIN_DATA_DIR, "ai-settings.json");

/** 空白服务商配置；默认 Anthropic 协议、超时 30000 秒 */
function blankProvider(name: string): AiProviderConfig {
	return {
		id: randomUUID(),
		name,
		protocol: "anthropic",
		baseUrl: "",
		apiKey: "",
		model: "",
		modelFast: "",
		webSearch: true,
		temperature: 0.7,
		timeoutSeconds: 30,
	};
}

export function defaultAiSettings(): AiSettings {
	const provider = blankProvider("默认配置");
	return {
		enable: false,
		providers: [provider],
		activeId: provider.id,
	};
}

/** 联网/温度/超时曾经是全局项：服务商条目缺省时用顶层值兜底（兼容中间版本文件） */
interface LegacyGlobals {
	webSearch?: unknown;
	temperature?: unknown;
	timeoutSeconds?: unknown;
}

/** 容错归一化单条服务商配置（防手改 json 出现缺字段/坏类型）；无法归一返回 null */
function normalizeProvider(raw: unknown, global: LegacyGlobals): AiProviderConfig | null {
	if (typeof raw !== "object" || raw === null) return null;
	const item = raw as Partial<AiProviderConfig>;
	return {
		id: typeof item.id === "string" && item.id !== "" ? item.id : randomUUID(),
		name: typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : "未命名",
		protocol: item.protocol === "openai" ? "openai" : "anthropic",
		baseUrl: typeof item.baseUrl === "string" ? item.baseUrl : "",
		apiKey: typeof item.apiKey === "string" ? item.apiKey : "",
		model: typeof item.model === "string" ? item.model : "",
		modelFast: typeof item.modelFast === "string" ? item.modelFast : "",
		webSearch: typeof item.webSearch === "boolean" ? item.webSearch : global.webSearch !== false,
		temperature: clampNumber(item.temperature ?? global.temperature, 0, 2, 0.7),
		timeoutSeconds: Math.round(clampNumber(item.timeoutSeconds ?? global.timeoutSeconds, 5, 86_400, 30)),
	};
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export async function loadAiSettings(): Promise<AiSettings> {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
	} catch {
		return defaultAiSettings();
	}

	const global: LegacyGlobals = {
		webSearch: raw.webSearch,
		temperature: raw.temperature,
		timeoutSeconds: raw.timeoutSeconds,
	};
	const settings: AiSettings = {
		enable: raw.enable === true,
		providers: [],
		activeId: typeof raw.activeId === "string" ? raw.activeId : "",
	};

	if (Array.isArray(raw.providers)) {
		for (const item of raw.providers) {
			const provider = normalizeProvider(item, global);
			if (provider) settings.providers.push(provider);
		}
	} else {
		// 旧版扁平单套配置：整体迁为名为「默认配置」的服务商
		const provider = normalizeProvider(raw, global);
		if (provider) {
			provider.name = "默认配置";
			settings.providers.push(provider);
		}
	}
	if (settings.providers.length === 0) return defaultAiSettings();
	if (!settings.providers.some((p) => p.id === settings.activeId)) {
		settings.activeId = settings.providers[0].id;
	}
	return settings;
}

export async function saveAiSettings(next: AiSettings): Promise<AiSettings> {
	// 兜底归位：activeId 必须指向存在的服务商
	if (next.providers.length > 0 && !next.providers.some((p) => p.id === next.activeId)) {
		next.activeId = next.providers[0].id;
	}
	await fs.mkdir(ADMIN_DATA_DIR, { recursive: true });
	await fs.writeFile(SETTINGS_FILE, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
	return next;
}

/** 当前生效的服务商；activeId 失效回退首个，空列表回退空白项（配合 aiReady 判否） */
export function activeProvider(settings: AiSettings): AiProviderConfig {
	return (
		settings.providers.find((p) => p.id === settings.activeId) ??
		settings.providers[0] ?? {
			id: "",
			name: "",
			protocol: "anthropic",
			baseUrl: "",
			apiKey: "",
			model: "",
			modelFast: "",
		}
	);
}

/** 配置完整可用（当前服务商的地址 / Key / 模型齐备） */
export function aiReady(settings: AiSettings): boolean {
	const provider = activeProvider(settings);
	return (
		/^https?:\/\//.test(provider.baseUrl.trim()) &&
		provider.apiKey.trim() !== "" &&
		provider.model.trim() !== ""
	);
}

/** 轻量任务模型：当前服务商的轻量模型，未配置回退主模型 */
export function fastModel(settings: AiSettings): string {
	const provider = activeProvider(settings);
	return provider.modelFast.trim() || provider.model;
}

/** 拼出 chat/completions 端点，容忍 baseUrl 自带尾斜杠或完整端点 */
function chatEndpoint(baseUrl: string): string {
	const root = baseUrl.trim().replace(/\/+$/, "");
	return root.endsWith("/chat/completions") ? root : `${root}/chat/completions`;
}

/** 拼出 anthropic messages 端点：容忍裸根、以 /v1 结尾、代理子路径与完整端点 */
function anthropicEndpoint(baseUrl: string): string {
	const root = baseUrl.trim().replace(/\/+$/, "");
	if (root.endsWith("/messages")) return root;
	if (/\/v\d+[a-z]*$/i.test(root)) return `${root}/messages`;
	return `${root}/v1/messages`;
}

interface ChatOptions {
	messages: AiChatMessage[];
	maxTokens?: number;
	temperature?: number;
	/** 覆盖设置里的超时（秒）；测试连接用短超时 */
	timeoutSeconds?: number;
	/** 覆盖设置里的联网检索开关（音乐搜索等场景强制开启） */
	webSearch?: boolean;
	/** 覆盖设置里的模型（轻量任务传 settings.modelFast）；缺省用主模型 */
	model?: string;
	/** 轻量任务关闭思考型模型的推理块（anthropic 协议显式 thinking disabled），避免小 maxTokens 被思考吃满 */
	noThink?: boolean;
	/** 流式请求（SSE）；写作任务用，配合 streamAiChat */
	stream?: boolean;
}

/** bigmodel 风格联网检索工具声明；不支持的服务会 4xx，由 callAiChat 降级重试 */
function webSearchTools(): unknown[] {
	return [{ type: "web_search", web_search: { enable: true, search_result: true } }];
}

interface RawResponse {
	status: number;
	statusText: string;
	text: string;
}

async function postJson(
	url: string,
	headers: Record<string, string>,
	body: unknown,
	signal: AbortSignal,
): Promise<RawResponse> {
	const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
	return { status: res.status, statusText: res.statusText, text: await res.text() };
}

function httpError(raw: RawResponse): ApiError {
	const detail = raw.text.slice(0, 300).replace(/\s+/g, " ");
	return new ApiError(502, `AI 服务返回 ${raw.status}：${detail || raw.statusText}`);
}

function parseOpenAiContent(text: string, fallbackModel: string): AiChatResult {
	const data = JSON.parse(text) as {
		choices?: { message?: { content?: string } }[];
		model?: string;
		usage?: { prompt_tokens?: number; completion_tokens?: number };
	};
	const content = data.choices?.[0]?.message?.content;
	if (typeof content !== "string") {
		throw new ApiError(502, "AI 服务应答格式异常：缺少 choices[0].message.content");
	}
	return {
		content,
		model: data.model ?? fallbackModel,
		promptTokens: data.usage?.prompt_tokens,
		completionTokens: data.usage?.completion_tokens,
	};
}

function parseAnthropicContent(text: string, fallbackModel: string): AiChatResult {
	const data = JSON.parse(text) as {
		content?: { type?: string; text?: string }[];
		model?: string;
		usage?: { input_tokens?: number; output_tokens?: number };
	};
	const content = (data.content ?? [])
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("");
	if (content === "") {
		throw new ApiError(502, "AI 服务应答格式异常：缺少 content 文本块（思考型模型可能占满了 max_tokens）");
	}
	return {
		content,
		model: data.model ?? fallbackModel,
		promptTokens: data.usage?.input_tokens,
		completionTokens: data.usage?.output_tokens,
	};
}

interface ChatRequest {
	url: string;
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** 构造双协议请求（callAiChat 与 streamAiChat 共用）；tools=false 时不带联网检索声明 */
function buildChatRequest(settings: AiSettings, options: ChatOptions, tools: boolean): ChatRequest {
	const provider = activeProvider(settings);
	const protocol: AiProtocol = provider.protocol === "anthropic" ? "anthropic" : "openai";
	const model = (options.model ?? provider.model).trim();
	const apiKey = provider.apiKey.trim();
	const body: Record<string, unknown> = {
		model,
		max_tokens: options.maxTokens ?? 2048,
		temperature: options.temperature ?? provider.temperature,
		stream: Boolean(options.stream),
	};
	if (tools) body.tools = webSearchTools();
	// 只对 anthropic 协议发 thinking disabled（官方与 GLM 等兼容端点均合法）；
	// openai 协议无跨厂商安全参数，不发——思考型模型靠调大 maxTokens 兜底
	if (options.noThink && protocol === "anthropic") body.thinking = { type: "disabled" };
	if (protocol === "anthropic") {
		// anthropic 协议不允许 system 出现在 messages 里，须提为顶层 system 字符串
		const systemText = options.messages
			.filter((m) => m.role === "system")
			.map((m) => m.content)
			.join("\n\n");
		if (systemText !== "") body.system = systemText;
		body.messages = options.messages.filter((m) => m.role !== "system");
		return {
			url: anthropicEndpoint(provider.baseUrl),
			headers: {
				"content-type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
				// 部分中转代理只认 Bearer，与 x-api-key 同发互不冲突
				authorization: `Bearer ${apiKey}`,
			},
			body,
		};
	}
	body.messages = options.messages;
	return {
		url: chatEndpoint(provider.baseUrl),
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body,
	};
}

/** 调用模型服务；失败统一抛 ApiError（中文原因） */
export async function callAiChat(settings: AiSettings, options: ChatOptions): Promise<AiChatResult> {
	if (!aiReady(settings)) {
		throw new ApiError(400, "AI 配置不完整：请先在「设置 → AI 助手」填写 API 地址、Key 与模型");
	}

	const provider = activeProvider(settings);
	const protocol: AiProtocol = provider.protocol === "anthropic" ? "anthropic" : "openai";
	const model = (options.model ?? provider.model).trim();
	const withTools = options.webSearch ?? provider.webSearch;

	const parse = (text: string): AiChatResult =>
		protocol === "anthropic" ? parseAnthropicContent(text, model) : parseOpenAiContent(text, model);

	const controller = new AbortController();
	const timeout = (options.timeoutSeconds ?? provider.timeoutSeconds) * 1000;
	const timer = setTimeout(() => controller.abort(), timeout);
	try {
		const firstReq = buildChatRequest(settings, options, withTools);
		const first = await postJson(firstReq.url, firstReq.headers, firstReq.body, controller.signal);
		if (first.status >= 200 && first.status < 300) {
			return withTools ? { ...parse(first.text), searchUsed: true } : parse(first.text);
		}
		// 检索工具不被支持（4xx 且报错提及 tool/search/function）时去掉 tools 降级重试一次
		if (withTools && first.status >= 400 && first.status < 500 && /tool|search|function/i.test(first.text)) {
			const retryReq = buildChatRequest(settings, options, false);
			const retry = await postJson(retryReq.url, retryReq.headers, retryReq.body, controller.signal);
			if (retry.status >= 200 && retry.status < 300) {
				return { ...parse(retry.text), searchUsed: false };
			}
			throw httpError(retry);
		}
		throw httpError(first);
	} catch (e) {
		if (e instanceof ApiError) throw e;
		if ((e as Error).name === "AbortError") {
			throw new ApiError(504, `AI 请求超时（${timeout / 1000}s），可尝试换更快的模型或代理线路`);
		}
		throw new ApiError(502, `无法连接 AI 服务：${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

export interface StreamHandlers {
	/** kind=thinking 是思考增量（灰字预览），kind=text 是正文增量 */
	onDelta(kind: "thinking" | "text", text: string): void;
}

/**
 * 流式调用（写作任务）：SSE 解析上游思考/正文增量，逐段回调。
 * 不关思考（这正是要展示给用户的内容）、不带联网检索工具；
 * 超时/客户端断开由调用方经 signal 传入，AbortError 原样抛出交上层定性。
 */
export async function streamAiChat(
	settings: AiSettings,
	options: ChatOptions,
	handlers: StreamHandlers,
	signal?: AbortSignal,
): Promise<AiChatResult> {
	if (!aiReady(settings)) {
		throw new ApiError(400, "AI 配置不完整：请先在「设置 → AI 助手」填写 API 地址、Key 与模型");
	}
	const provider = activeProvider(settings);
	const protocol: AiProtocol = provider.protocol === "anthropic" ? "anthropic" : "openai";
	const model = (options.model ?? provider.model).trim();
	const request = buildChatRequest(settings, { ...options, stream: true, webSearch: false }, false);

	let res: Response;
	try {
		res = await fetch(request.url, {
			method: "POST",
			headers: request.headers,
			body: JSON.stringify(request.body),
			signal,
		});
	} catch (e) {
		// AbortError 原样上抛：由路由层区分「用户停止」与「超时」
		if ((e as Error).name === "AbortError") throw e;
		throw new ApiError(502, `无法连接 AI 服务：${(e as Error).message}`);
	}
	if (!res.ok || !res.body) {
		const text = await res.text().catch(() => "");
		throw httpError({ status: res.status, statusText: res.statusText, text });
	}

	// holder 对象规避 TS 闭包 narrowing（同仓库既有惯例）
	const state = { thinking: "", content: "", completionTokens: undefined as number | undefined, done: false };
	const emit = (kind: "thinking" | "text", text: string): void => {
		if (text === "") return;
		if (kind === "thinking") state.thinking += text;
		else state.content += text;
		handlers.onDelta(kind, text);
	};

	/** 单条上游 SSE 事件分发；返回 true 表示流应终止 */
	const handleEvent = (payload: string): boolean => {
		if (payload === "[DONE]") return true;
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(payload) as Record<string, unknown>;
		} catch {
			return false; // 容忍非 JSON 心跳/注释行
		}
		if (protocol === "anthropic") {
			const type = data.type as string | undefined;
			if (type === "content_block_delta") {
				const delta = data.delta as { type?: string; text?: string; thinking?: string } | undefined;
				if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") emit("thinking", delta.thinking);
				else if (delta?.type === "text_delta" && typeof delta.text === "string") emit("text", delta.text);
			} else if (type === "message_delta") {
				const usage = data.usage as { output_tokens?: number } | undefined;
				if (typeof usage?.output_tokens === "number") state.completionTokens = usage.output_tokens;
			} else if (type === "message_stop") {
				return true;
			} else if (type === "error") {
				const err = data.error as { message?: string } | undefined;
				throw new ApiError(502, `AI 流式返回错误：${err?.message ?? "未知错误"}`);
			}
			return false;
		}
		// openai 兼容：GLM/DeepSeek 风格 reasoning_content 即思考
		const choice = (data.choices as { delta?: { content?: string; reasoning_content?: string } }[] | undefined)?.[0];
		if (choice?.delta) {
			if (typeof choice.delta.reasoning_content === "string") emit("thinking", choice.delta.reasoning_content);
			if (typeof choice.delta.content === "string") emit("text", choice.delta.content);
		}
		const usage = data.usage as { completion_tokens?: number } | undefined;
		if (typeof usage?.completion_tokens === "number") state.completionTokens = usage.completion_tokens;
		return false;
	};

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (!state.done) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let sep = buffer.indexOf("\n\n");
			while (sep >= 0) {
				const frame = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				for (const line of frame.split("\n")) {
					if (!line.startsWith("data:")) continue;
					const payload = line.slice(5).trim();
					if (payload !== "" && handleEvent(payload)) {
						state.done = true;
						break;
					}
				}
				if (state.done) break;
				sep = buffer.indexOf("\n\n");
			}
		}
	} catch (e) {
		if (e instanceof ApiError || (e as Error).name === "AbortError") throw e;
		throw new ApiError(502, `AI 流式读取失败：${(e as Error).message}`);
	} finally {
		await reader.cancel().catch(() => {});
	}
	if (state.content === "") {
		throw new ApiError(502, "AI 未返回任何正文（思考可能占满了 max_tokens，可重试或调大长度限制）");
	}
	return { content: state.content, model, completionTokens: state.completionTokens };
}
