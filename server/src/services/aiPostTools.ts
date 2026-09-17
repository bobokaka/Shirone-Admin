import { readPostBody } from "../adapters/storage.js";
import type { AiToolCall, AiToolDef } from "./aiSettings.js";

/**
 * 文章优化任务的读取工具集：客户端只传指令与文章路径，不上送正文；
 * 模型在执行时自行决定读不读、怎么读、读哪些（大纲定位 → 区间精读 / 整篇 / 选区）。
 */

export interface PostToolContext {
	/** 文章相对路径（content/posts 下，如 my-post/index.md） */
	postPath: string;
	/** 用户选区（正文字符偏移，与编辑器正文同坐标系）；无选区为 null */
	selection: { start: number; end: number } | null;
}

const outlineDef: AiToolDef = {
	name: "get_outline",
	description: "获取目标文章的标题大纲（每行：行号 + 标题层级 + 标题文本）。长文先看大纲，再决定精读哪些区段。",
	parameters: { type: "object", properties: {}, required: [] },
};

const readDef: AiToolDef = {
	name: "read_post",
	description:
		"读取目标文章的 Markdown 正文。不传参数读整篇；可传 startLine/endLine（1 起、含端点）读行区间，长文建议分块读取。",
	parameters: {
		type: "object",
		properties: {
			startLine: { type: "number", description: "起始行（1 起，含）" },
			endLine: { type: "number", description: "结束行（含）" },
		},
		required: [],
	},
};

const selectionDef: AiToolDef = {
	name: "read_selection",
	description: "读取用户在编辑器中选中的文字片段（作用于选中内容的任务用它取原文）。",
	parameters: { type: "object", properties: {}, required: [] },
};

/** 按上下文组装工具声明（有选区才提供 read_selection） */
export function postToolDefs(selection: { start: number; end: number } | null): AiToolDef[] {
	return selection === null ? [outlineDef, readDef] : [outlineDef, readDef, selectionDef];
}

function toInt(v: unknown): number | undefined {
	const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** 执行一次工具调用；读取失败也返回文本说明（交给模型自行处置），不中断流 */
export async function executePostTool(call: AiToolCall, ctx: PostToolContext): Promise<string> {
	try {
		const body = await readPostBody(ctx.postPath);
		if (call.name === "read_post") {
			const lines = body.split("\n");
			const start = Math.min(toInt(call.args.startLine) ?? 1, lines.length);
			const end = Math.min(toInt(call.args.endLine) ?? lines.length, lines.length);
			if (start > end) return "（无效行区间：startLine 大于 endLine）";
			return lines.slice(start - 1, end).join("\n");
		}
		if (call.name === "get_outline") {
			const out: string[] = [];
			body.split("\n").forEach((line, i) => {
				const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
				if (m) out.push(`L${i + 1} ${m[1]} ${m[2]}`);
			});
			return out.length > 0 ? out.join("\n") : "（文章没有 Markdown 标题结构，请直接 read_post 读取全文）";
		}
		if (call.name === "read_selection") {
			if (ctx.selection === null) return "（当前没有选区）";
			return body.slice(ctx.selection.start, ctx.selection.end);
		}
		return `（未知工具：${call.name}）`;
	} catch (e) {
		return `（读取失败：${(e as Error).message}）`;
	}
}
