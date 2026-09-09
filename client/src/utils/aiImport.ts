import type { AiProtocol } from "@shirone-admin/shared";

/**
 * 解析粘贴的 AI 服务配置（Claude Code settings.json 的 env 块、裸 env 对象、
 * shell export / dotenv 语句），产出可合并进设置表单的补丁。纯函数，永不抛错。
 */

export interface AiImportPatch {
	protocol?: AiProtocol;
	baseUrl?: string;
	apiKey?: string;
	model?: string;
	modelFast?: string;
	timeoutSeconds?: number;
}

export interface AiImportResult {
	patch: AiImportPatch;
	/** 已识别并消费的源键名 */
	recognized: string[];
	/** 提取到但未使用的键名 */
	ignored: string[];
}

const KNOWN_KEYS = new Set([
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_DEFAULT_OPUS_MODEL",
	"ANTHROPIC_DEFAULT_SONNET_MODEL",
	"ANTHROPIC_DEFAULT_HAIKU_MODEL",
	"ANTHROPIC_MODEL",
	"OPENAI_BASE_URL",
	"OPENAI_API_KEY",
	"API_TIMEOUT_MS",
]);

function stringifyEnv(env: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (value === null || value === undefined) continue;
		out[key] = typeof value === "string" ? value : String(value);
	}
	return out;
}

function looksEnvLike(key: string): boolean {
	return /^[A-Z][A-Z0-9_]*$/.test(key);
}

/** 从粘贴文本提取 env 键值袋；提取不到返回空对象 */
function extractEnvBag(text: string): Record<string, string> {
	const cleaned = text
		.replace(/^﻿/, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/,\s*([}\]])/g, "$1")
		.trim();
	if (cleaned !== "") {
		try {
			const root = JSON.parse(cleaned) as unknown;
			if (typeof root === "object" && root !== null && !Array.isArray(root)) {
				const record = root as Record<string, unknown>;
				if (typeof record.env === "object" && record.env !== null && !Array.isArray(record.env)) {
					return stringifyEnv(record.env as Record<string, unknown>);
				}
				const entries = Object.keys(record);
				if (entries.length > 0 && entries.every(looksEnvLike)) {
					return stringifyEnv(record);
				}
			}
		} catch {
			// 落到行解析
		}
	}
	const bag: Record<string, string> = {};
	const lineRe = /(?:^|\n)[ \t]*(?:export[ \t]+|set[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*("([^"\n]*)"|'([^'\n]*)'|[^\s#]+)/g;
	for (const match of text.matchAll(lineRe)) {
		const key = match[1];
		const value = match[2];
		if (key === undefined || value === undefined) continue;
		bag[key.toUpperCase()] = value;
	}
	return bag;
}

function pick(bag: Record<string, string>, key: string): string | undefined {
	const raw = bag[key];
	if (typeof raw !== "string") return undefined;
	const value = raw.trim().replace(/^["']|["']$/g, "");
	return value === "" ? undefined : value;
}

export function parseAiEnvImport(text: string): AiImportResult {
	const bag = extractEnvBag(text);
	const patch: AiImportPatch = {};

	const anthropicBase = pick(bag, "ANTHROPIC_BASE_URL");
	const openaiBase = pick(bag, "OPENAI_BASE_URL");
	const anthropicKey = pick(bag, "ANTHROPIC_AUTH_TOKEN") ?? pick(bag, "ANTHROPIC_API_KEY");
	const openaiKey = pick(bag, "OPENAI_API_KEY");
	const opusModel = pick(bag, "ANTHROPIC_DEFAULT_OPUS_MODEL");
	const sonnetModel = pick(bag, "ANTHROPIC_DEFAULT_SONNET_MODEL");
	const haikuModel = pick(bag, "ANTHROPIC_DEFAULT_HAIKU_MODEL");
	const plainModel = pick(bag, "ANTHROPIC_MODEL");
	const timeoutMs = pick(bag, "API_TIMEOUT_MS");

	if (anthropicBase !== undefined) {
		patch.protocol = "anthropic";
		patch.baseUrl = anthropicBase;
	} else if (openaiBase !== undefined) {
		patch.protocol = "openai";
		patch.baseUrl = openaiBase;
	}
	if (anthropicKey !== undefined) patch.apiKey = anthropicKey;
	else if (openaiKey !== undefined) patch.apiKey = openaiKey;

	const primary = opusModel ?? sonnetModel ?? plainModel ?? haikuModel;
	if (primary !== undefined) patch.model = primary;
	// haiku 档作轻量模型，仅当与主模型不同才有意义
	if (haikuModel !== undefined && haikuModel !== patch.model) patch.modelFast = haikuModel;

	if (timeoutMs !== undefined) {
		const ms = Number.parseInt(timeoutMs, 10);
		if (Number.isFinite(ms) && ms > 0) {
			patch.timeoutSeconds = Math.min(86_400, Math.max(5, Math.round(ms / 1000)));
		}
	}

	const recognized: string[] = [];
	const ignored: string[] = [];
	for (const key of Object.keys(bag)) {
		if (KNOWN_KEYS.has(key) && pick(bag, key) !== undefined) recognized.push(key);
		else ignored.push(key);
	}
	return { patch, recognized, ignored };
}
