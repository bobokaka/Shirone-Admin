import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AiChatResult } from "@shirone-admin/shared";
import { readPostBody } from "../adapters/storage.js";
import { ApiError } from "../lib/errors.js";
import {
	activeProvider,
	aiReady,
	callAiChat,
	defaultAiSettings,
	fastModel,
	loadAiSettings,
	saveAiSettings,
	streamAiChat,
	type AgentChatMessage,
	type AiToolCall,
	type AiToolDef,
} from "../services/aiSettings.js";
import { generateCommitMessage } from "../services/commitMessage.js";
import { searchMusicWithAi } from "../services/musicSearch.js";
import { executePostTool, postToolDefs } from "../services/aiPostTools.js";
import {
	appendMessage,
	createSession,
	effectiveMessages,
	loadSession,
	rollbackLastUser,
	type AiSession,
} from "../services/aiSession.js";
import { draftTimeline } from "../services/timelineDraft.js";
import { scrapeWallpapers } from "../services/wallpaperSearch.js";

/** edit-stream 的请求体：文章任务只传 postPath（正文由模型经工具自取）；text 保留给说说/表单等小文本任务 */
const editStreamSchema = z
	.object({
		instruction: z.string().min(1).max(2_000),
		/** 小文本任务（说说、表单字段）：直接内联，无文件可读 */
		text: z.string().max(100_000).optional(),
		/** 文章任务：目标文章（content/posts 相对路径） */
		postPath: z.string().min(1).max(300).optional(),
		/** 编辑器选区（正文字符偏移），仅文章任务有效 */
		selectionStart: z.number().int().min(0).optional(),
		selectionEnd: z.number().int().min(0).optional(),
		maxTokens: z.number().int().min(16).max(16_384).optional(),
	})
	.refine((b) => (b.text ?? "") !== "" || b.postPath !== undefined, {
		message: "需提供待处理文本或目标文章路径",
	});

/** 文章优化会话的 system：模型经读取工具自取原文（大纲 → 区间 / 整篇 / 选区） */
const EDIT_AGENT_SYSTEM =
	"你是 Markdown 技术博客的写作助手，可调用工具按需读取目标文章的原文：长文先 get_outline 看结构，再 read_post 精读需要的区段或整篇；作用于选中内容的任务用 read_selection。动笔前必须读到相关原文，不要凭空编造。完成指令后只输出结果本身（要求输出全文时给完整正文），不要任何解释、前后缀或代码围栏。";

/** 小文本任务（说说/表单字段）的 system：文本已内联在指令里 */
const EDIT_INLINE_SYSTEM =
	"你是 Markdown 技术博客的写作助手。依据指令改写用户给出的文本，只输出改写结果本身，不要任何解释、前后缀或代码围栏。";

/** chat-stream 的请求体：会话续话——sessionId 续已有会话，缺省新建；上下文由服务端持有 */
const chatStreamSchema = z.object({
	sessionId: z.string().uuid().optional(),
	message: z.string().min(1).max(100_000),
	system: z.string().max(10_000).optional(),
	maxTokens: z.number().int().min(16).max(16_384).optional(),
});

/** 代理配置：声明给模型的工具与执行器（edit-stream 文章任务用） */
interface StreamAgent {
	tools: AiToolDef[];
	execute(call: AiToolCall): Promise<string>;
}

/** 上游 4xx 且报错指向工具/函数能力缺失（httpError 文本含原始状态码与详情）：可降级重试 */
function toolUnsupported(e: unknown): boolean {
	return e instanceof ApiError && /AI 服务返回 4\d\d：.*(tool|function)/is.test(e.message);
}

/**
 * SSE 转发核心（edit-stream / chat-stream 共用，会话式）：
 * 自定义帧格式（每帧一行 data JSON）：thinking / text 增量 → done（含全文与 sessionId）或 error。
 * 客户端断开（用户点停止/关页面）即中止上游；超时按「无输出闲置」计，不限制总时长。
 * 传入 agent 时走代理循环：模型请求读取工具 → 执行 → 结果回传继续生成，直到产出正文；
 * 端点不支持工具调用则降级为服务端读全文内联一次直生成。
 * 本轮成功：结果写回会话后再发 done；停止/超时/失败：回滚本轮 user 消息，会话停留在上一个完整轮次。
 */
async function pipeSseStream(
	reply: FastifyReply,
	settings: Awaited<ReturnType<typeof loadAiSettings>>,
	session: AiSession,
	maxTokens: number,
	agent?: StreamAgent,
): Promise<void> {
	reply.hijack();
	const raw = reply.raw;
	raw.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	const send = (payload: unknown): void => {
		if (raw.destroyed || raw.writableEnded) return;
		raw.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	const upstream = new AbortController();
	let abortReason: "stop" | "timeout" | null = null;
	raw.on("close", () => {
		if (abortReason === null) abortReason = "stop";
		upstream.abort();
	});
	// 闲置超时（当前服务商的超时配置）：每次收到上游增量即重置；长文生成不受总时长限制
	const idleSeconds = activeProvider(settings).timeoutSeconds;
	let idleTimer: NodeJS.Timeout | null = null;
	const armIdle = (): void => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			if (abortReason === null) abortReason = "timeout";
			upstream.abort();
		}, idleSeconds * 1000);
	};

	try {
		armIdle();
		/** 单轮流式：返回结果与本轮正文增量（模型偶尔在调用工具前输出说明文字，需带回上下文） */
		const streamOnce = (messages: AgentChatMessage[], tools?: AiToolDef[]) => {
			let text = "";
			const promise = streamAiChat(
				settings,
				{ messages, maxTokens, ...(tools?.length ? { tools } : {}) },
				{
					onDelta: (kind, delta) => {
						armIdle();
						if (kind === "text") text += delta;
						send({ type: kind, text: delta });
					},
				},
				upstream.signal,
			);
			return promise.then((result) => ({ result, text }));
		};

		/** 代理循环：工具调用轮次执行读取（思考流透出进度），直到模型产出正文 */
		const runLoop = async (initial: AgentChatMessage[], useAgent: boolean): Promise<AiChatResult> => {
			const working = [...initial];
			for (let round = 0; ; round++) {
				const { result, text: roundText } = await streamOnce(working, useAgent ? agent?.tools : undefined);
				if (result.toolCalls.length === 0 || !agent) return result;
				if (round >= 12) throw new ApiError(502, "AI 连续调用工具未产出结果，请重试或换模型");
				send({
					type: "thinking",
					text: `\n[调用 ${result.toolCalls.map((t) => t.name).join("、")} 读取文章]\n`,
				});
				working.push({ role: "assistant", content: roundText, toolCalls: result.toolCalls });
				for (const call of result.toolCalls) {
					const output = await agent.execute(call);
					send({ type: "thinking", text: `（${call.name} 返回 ${output.length} 字符）\n` });
					working.push({ role: "tool", toolCallId: call.id, content: output });
				}
			}
		};

		let final: AiChatResult;
		try {
			final = await runLoop(effectiveMessages(session), true);
		} catch (e) {
			if (!agent || !toolUnsupported(e)) throw e;
			// 端点不支持工具调用：服务端自行读全文内联进指令，降级为一次直生成
			const initial = effectiveMessages(session);
			const fullText = await agent.execute({ id: "fallback", name: "read_post", args: {} });
			const lastUser = initial.map((m) => m.role).lastIndexOf("user");
			if (lastUser >= 0) {
				initial[lastUser] = { role: "user", content: `${initial[lastUser].content}\n\n文本：\n${fullText}` };
			}
			final = await runLoop(initial, false);
		}
		// 先落会话再报 done：客户端拿到 sessionId 即可立刻续轮，assistant 必已就位
		await appendMessage(session.id, { role: "assistant", content: final.content });
		send({
			type: "done",
			content: final.content,
			model: final.model,
			completionTokens: final.completionTokens,
			sessionId: session.id,
		});
	} catch (e) {
		// 本轮无完整产出：回滚 user 消息，保证会话仍是严格交替的完整轮次
		await rollbackLastUser(session.id);
		if ((e as Error).name === "AbortError" && abortReason !== "timeout") {
			// 用户主动停止/页面关闭：连接已断，静默收尾
		} else {
			const message =
				abortReason === "timeout"
					? `AI 生成超时（${idleSeconds}s 无输出）`
					: e instanceof ApiError
						? e.message
						: `AI 流式调用失败：${(e as Error).message}`;
			send({ type: "error", message });
		}
	} finally {
		if (idleTimer) clearTimeout(idleTimer);
		raw.end();
	}
}

const providerSchema = z.object({
	id: z.string().min(1).max(64),
	name: z.string().trim().min(1).max(50),
	protocol: z.enum(["anthropic", "openai"]).default("anthropic"),
	baseUrl: z.string().trim().default(""),
	apiKey: z.string().default(""),
	model: z.string().trim().default(""),
	modelFast: z.string().trim().default(""),
	webSearch: z.boolean().default(true),
	temperature: z.number().min(0).max(2).default(0.7),
	timeoutSeconds: z.number().int().min(5).max(86_400).default(30),
});

const settingsSchema = z
	.object({
		enable: z.boolean(),
		providers: z.array(providerSchema).min(1).max(20),
		activeId: z.string().min(1),
	})
	.refine((s) => s.providers.some((p) => p.id === s.activeId), {
		message: "当前服务商必须指向已保存的配置项",
	});

const chatSchema = z.object({
	messages: z
		.array(
			z.object({
				role: z.enum(["system", "user", "assistant"]),
				content: z.string().max(200_000),
			}),
		)
		.min(1),
	maxTokens: z.number().int().min(16).max(16_384).optional(),
	/** 轻量任务（标签建议等）走 modelFast，未设置回退主模型 */
	fast: z.boolean().optional(),
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
	app.get("/api/ai/settings", async () => loadAiSettings());

	app.put("/api/ai/settings", async (req) => {
		const settings = settingsSchema.parse(req.body);
		if (settings.enable && !aiReady(settings)) {
			throw new ApiError(400, "启用 AI 前需为当前选中的服务商填写完整的 API 地址（http(s) 开头）、API Key 与模型名");
		}
		return saveAiSettings(settings);
	});

	/** 测试连接：优先用表单提交的配置（未保存也能测），回退已保存配置 */
	app.post("/api/ai/test", async (req) => {
		const parsed = settingsSchema.safeParse(req.body ?? {});
		const settings = parsed.success ? parsed.data : await loadAiSettings();
		const started = Date.now();
		if (!aiReady(settings)) {
			return { ok: false, latencyMs: 0, error: "配置不完整：API 地址、Key 与模型名均不可为空" };
		}
		try {
			const result = await callAiChat(
				{ ...defaultAiSettings(), ...settings },
				{
					messages: [{ role: "user", content: "请只回复四个字：连接成功" }],
					maxTokens: 16,
					temperature: 0,
					timeoutSeconds: Math.min(activeProvider(settings).timeoutSeconds, 30),
					webSearch: false,
					noThink: true,
				},
			);
			return {
				ok: true,
				latencyMs: Date.now() - started,
				reply: result.content.trim().slice(0, 120),
			};
		} catch (e) {
			return { ok: false, latencyMs: Date.now() - started, error: (e as Error).message };
		}
	});

	/** AI 对话入口（编辑器辅助写作走这里），始终使用已保存的配置 */
	app.post("/api/ai/chat", async (req) => {
		const body = chatSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		// fast=true 时用轻量模型（未配置回退主模型，即与默认一致）
		const model = body.fast ? fastModel(settings) : undefined;
		// 轻量任务（标签建议等）同时关思考，避免小 maxTokens 被推理块吃满
		return callAiChat(settings, {
			messages: body.messages,
			maxTokens: body.maxTokens,
			...(model ? { model } : {}),
			...(body.fast ? { noThink: true } : {}),
		});
	});

	/**
	 * 流式优化（SSE）：思考/正文增量实时下发，写作任务可看到模型在干什么、随时停止。
	 * 文章任务（postPath）：客户端不上送正文，模型经读取工具（大纲/区间/选区）自行取原文，
	 * 工具活动透出到思考流；端点不支持工具时自动降级为服务端读全文内联直生成。
	 * 小文本任务（text）：直接内联（说说、表单字段等，无文件可读）。
	 * 首轮即新会话：后续追问走 chat-stream 续会话（只传 sessionId + 指令）。
	 */
	app.post("/api/ai/edit-stream", async (req, reply) => {
		const body = editStreamSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		const postPath = body.postPath;
		// 文章路径先验证（hijack 前以 JSON 报 404，而不是流中途报错）
		if (postPath !== undefined) await readPostBody(postPath);
		const selection =
			postPath !== undefined && body.selectionStart !== undefined && body.selectionEnd !== undefined
				? { start: body.selectionStart, end: body.selectionEnd }
				: null;
		const userContent =
			postPath !== undefined
				? `指令：${body.instruction}\n（目标文章：${postPath}${
						selection ? "；用户选中了正文中一段文字，用 read_selection 读取" : ""
					}；原文由你按需读取）`
				: `指令：${body.instruction}\n\n文本：\n${body.text}`;
		const session = await createSession(postPath !== undefined ? EDIT_AGENT_SYSTEM : EDIT_INLINE_SYSTEM);
		await appendMessage(session.id, { role: "user", content: userContent });
		const agent: StreamAgent | undefined =
			postPath !== undefined
				? {
						tools: postToolDefs(selection),
						execute: (call) => executePostTool(call, { postPath, selection }),
					}
				: undefined;
		await pipeSseStream(reply, settings, session, body.maxTokens ?? 4096, agent);
	});

	/**
	 * 流式多轮对话（SSE）：控制台追问/续改共用，帧格式与 edit-stream 一致。
	 * sessionId 续已有会话（服务端读会话文件组装上下文，客户端不重传历史）；
	 * 会话不存在（已被淘汰/清理）则用提交的 system 新建，done 帧回传实际 sessionId。
	 */
	app.post("/api/ai/chat-stream", async (req, reply) => {
		const body = chatStreamSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		const session = (body.sessionId ? await loadSession(body.sessionId) : null) ?? (await createSession(body.system ?? ""));
		await appendMessage(session.id, { role: "user", content: body.message });
		await pipeSseStream(reply, settings, session, body.maxTokens ?? 8192);
	});

	/** 音乐版权检索（联网优先，不支持的服务自动降级并标记 searchUsed=false） */
	app.post("/api/ai/music-search", async (req) => {
		const body = z.object({ query: z.string().trim().min(1).max(200) }).parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		return searchMusicWithAi(body.query);
	});

	/** 壁纸抓取（safebooru 二次元图源直取，尺寸匹配目标端，凑满一批；不走 AI，无启用门槛） */
	app.post("/api/ai/wallpaper-search", async (req) => {
		const body = z
			.object({
				query: z.string().trim().max(200).default(""),
				target: z.enum(["desktop", "mobile"]),
			})
			.parse(req.body);
		return scrapeWallpapers(body.query, body.target);
	});

	/** AI 提交信息生成（失败或输出不合规自动回退启发式，永不阻断发布）；repo 指定按哪仓变更生成 */
	app.post("/api/ai/commit-message", async (req) => {
		const { repo } = z.object({ repo: z.enum(["content", "theme"]).default("content") }).parse(req.body ?? {});
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		return generateCommitMessage(repo);
	});

	/** 时间线事件 AI 起草（git 扫描三仓提交历史 / note 按描述起草） */
	app.post("/api/ai/timeline-draft", async (req) => {
		const body = z
			.object({
				mode: z.enum(["note", "git"]),
				note: z.string().trim().max(500).optional(),
				limit: z.number().int().min(1).max(5).optional(),
				existing: z
					.array(z.object({ title: z.string().trim().max(120), date: z.string().trim().max(12) }))
					.max(300)
					.optional(),
			})
			.refine((b) => b.mode === "git" || (b.note ?? "").trim() !== "", {
				message: "描述生成模式需提供事件描述",
			})
			.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		return draftTimeline(body);
	});
}
