import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { AiChatMessage } from "@shirone-admin/shared";
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
} from "../services/aiSettings.js";
import { generateCommitMessage } from "../services/commitMessage.js";
import { searchMusicWithAi } from "../services/musicSearch.js";
import { draftTimeline } from "../services/timelineDraft.js";
import { scrapeWallpapers } from "../services/wallpaperSearch.js";

/** edit / edit-stream 共用的请求体 */
const editSchema = z.object({
	instruction: z.string().min(1).max(2_000),
	text: z.string().max(100_000),
	maxTokens: z.number().int().min(16).max(16_384).optional(),
});

/** edit / edit-stream 共用的消息组装 */
function editMessages(instruction: string, text: string): AiChatMessage[] {
	return [
		{
			role: "system",
			content:
				"你是 Markdown 技术博客的写作助手。依据指令改写用户给出的文本，只输出改写结果本身，不要任何解释、前后缀或代码围栏。",
		},
		{ role: "user", content: `指令：${instruction}\n\n文本：\n${text}` },
	];
}

/** chat-stream 的请求体：完整多轮对话（user/assistant 交替），system 独立传 */
const chatStreamSchema = z.object({
	messages: z
		.array(
			z.object({
				role: z.enum(["user", "assistant"]),
				content: z.string().min(1).max(100_000),
			}),
		)
		.min(1)
		.max(40),
	system: z.string().max(10_000).optional(),
	maxTokens: z.number().int().min(16).max(16_384).optional(),
});

/**
 * SSE 转发核心（edit-stream / chat-stream 共用）：
 * 自定义帧格式（每帧一行 data JSON）：thinking / text 增量 → done（含全文）或 error。
 * 客户端断开（用户点停止/关页面）即中止上游；超时按「无输出闲置」计，不限制总时长。
 */
async function pipeSseStream(
	reply: FastifyReply,
	settings: Awaited<ReturnType<typeof loadAiSettings>>,
	messages: AiChatMessage[],
	maxTokens: number,
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
		const result = await streamAiChat(
			settings,
			{ messages, maxTokens },
			{
				onDelta: (kind, text) => {
					armIdle();
					send({ type: kind, text });
				},
			},
			upstream.signal,
		);
		send({ type: "done", content: result.content, model: result.model, completionTokens: result.completionTokens });
	} catch (e) {
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

	/** 便捷封装：单条指令润色/改写选中文本（编辑器用） */
	app.post("/api/ai/edit", async (req) => {
		const body = editSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		return callAiChat(settings, { messages: editMessages(body.instruction, body.text), maxTokens: body.maxTokens ?? 4096 });
	});

	/**
	 * 流式改写（SSE）：思考/正文增量实时下发，写作任务可看到模型在干什么、随时停止。
	 */
	app.post("/api/ai/edit-stream", async (req, reply) => {
		const body = editSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		await pipeSseStream(reply, settings, editMessages(body.instruction, body.text), body.maxTokens ?? 4096);
	});

	/**
	 * 流式多轮对话（SSE）：控制台追问/自由聊天入口，帧格式与 edit-stream 一致。
	 */
	app.post("/api/ai/chat-stream", async (req, reply) => {
		const body = chatStreamSchema.parse(req.body);
		const settings = await loadAiSettings();
		if (!settings.enable) {
			throw new ApiError(400, "AI 助手未启用：请先在「设置 → AI 助手」开启并保存");
		}
		const messages: AiChatMessage[] = [
			...(body.system ? [{ role: "system" as const, content: body.system }] : []),
			...body.messages,
		];
		await pipeSseStream(reply, settings, messages, body.maxTokens ?? 8192);
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
