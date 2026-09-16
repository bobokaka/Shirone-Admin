import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AiChatMessage } from "@shirone-admin/shared";
import { ADMIN_DATA_DIR } from "../config.js";

/**
 * AI 会话存储：多轮对话上下文由服务端持有，客户端每轮只传会话 ID + 新消息。
 * 会话落盘 server/data/ai-sessions/<id>.json（ADMIN_DATA_DIR 已 gitignore），
 * 内存缓存加速热会话；服务重启后按 ID 从磁盘恢复。
 * messages 恒为 user/assistant 严格交替且以 user 开头（anthropic 协议硬约束）。
 */

const SESSIONS_DIR = path.join(ADMIN_DATA_DIR, "ai-sessions");
/** 磁盘保留的会话文件数：创建新会话时按更新时间淘汰多余的 */
const KEEP_FILES = 30;
/** 上送模型的上下文预算（字符）：超出从最旧的一对 user/assistant 开始丢弃 */
const SESSION_BUDGET = 200_000;

export interface AiSession {
	id: string;
	system: string;
	messages: Array<Pick<AiChatMessage, "role" | "content"> & { role: "user" | "assistant" }>;
	updatedAt: string;
}

const cache = new Map<string, AiSession>();

function sessionFile(id: string): string {
	return path.join(SESSIONS_DIR, `${id}.json`);
}

/** 容错解析会话文件；ID 非法（路径穿越）或文件损坏返回 null */
function parseSession(id: string, text: string): AiSession | null {
	if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
	try {
		const raw = JSON.parse(text) as Partial<AiSession>;
		if (typeof raw.id !== "string" || !Array.isArray(raw.messages)) return null;
		const messages = raw.messages
			.filter(
				(m): m is AiSession["messages"][number] =>
					(m?.role === "user" || m?.role === "assistant") && typeof m.content === "string",
			)
			.map((m) => ({ role: m.role, content: m.content }));
		return {
			id: raw.id,
			system: typeof raw.system === "string" ? raw.system : "",
			messages,
			updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
		};
	} catch {
		return null;
	}
}

async function persist(session: AiSession): Promise<void> {
	await fs.mkdir(SESSIONS_DIR, { recursive: true });
	await fs.writeFile(sessionFile(session.id), `${JSON.stringify(session, null, "\t")}\n`, "utf8");
}

/** 创建新会话并落盘；顺手淘汰过旧的会话文件（尽力而为，不阻塞） */
export async function createSession(system: string): Promise<AiSession> {
	const session: AiSession = {
		id: randomUUID(),
		system,
		messages: [],
		updatedAt: new Date().toISOString(),
	};
	cache.set(session.id, session);
	await persist(session);
	void evictOldSessions();
	return session;
}

/** 读会话：内存命中直接返回，否则读盘并回填缓存；不存在/损坏返回 null */
export async function loadSession(id: string): Promise<AiSession | null> {
	const hit = cache.get(id);
	if (hit) return hit;
	try {
		const session = parseSession(id, await fs.readFile(sessionFile(id), "utf8"));
		if (session) cache.set(session.id, session);
		return session;
	} catch {
		return null;
	}
}

/** 追加一条消息（user 先写入，流式成功后再补 assistant） */
export async function appendMessage(
	id: string,
	message: AiSession["messages"][number],
): Promise<AiSession | null> {
	const session = await loadSession(id);
	if (!session) return null;
	session.messages.push(message);
	session.updatedAt = new Date().toISOString();
	await persist(session);
	return session;
}

/** 回滚最后一条 user 消息：本轮停止/失败时调用，保证会话仍严格交替 */
export async function rollbackLastUser(id: string): Promise<void> {
	const session = await loadSession(id);
	if (!session) return;
	const last = session.messages.at(-1);
	if (last?.role !== "user") return;
	session.messages.pop();
	session.updatedAt = new Date().toISOString();
	await persist(session);
}

/**
 * 组装实际上送的上下文：system + 裁剪后的消息。
 * 超预算时从头部成对丢弃（user+assistant 同删，保持交替与 user 开头），
 * 最近一轮（含最新结果）永不丢弃。
 */
export function effectiveMessages(session: AiSession): AiChatMessage[] {
	let total = session.messages.reduce((sum, m) => sum + m.content.length, 0);
	let drop = 0;
	while (total > SESSION_BUDGET && session.messages.length - drop > 2) {
		total -= session.messages[drop].content.length + session.messages[drop + 1].content.length;
		drop += 2;
	}
	return [
		...(session.system !== "" ? [{ role: "system" as const, content: session.system }] : []),
		...session.messages.slice(drop),
	];
}

/** 按 mtime 淘汰：只保留最新的 KEEP_FILES 个会话文件 */
async function evictOldSessions(): Promise<void> {
	try {
		const names = (await fs.readdir(SESSIONS_DIR)).filter((n) => n.endsWith(".json"));
		const statted = await Promise.all(
			names.map(async (name) => {
				const file = path.join(SESSIONS_DIR, name);
				const stat = await fs.stat(file).catch(() => null);
				return { file, mtime: stat?.mtimeMs ?? 0 };
			}),
		);
		statted.sort((a, b) => b.mtime - a.mtime);
		for (const { file } of statted.slice(KEEP_FILES)) {
			await fs.unlink(file).catch(() => {});
			const id = path.basename(file, ".json");
			cache.delete(id);
		}
	} catch {
		// 目录不存在等：创建会话时已 mkdir，这里无需处理
	}
}
