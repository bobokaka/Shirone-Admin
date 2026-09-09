/**
 * 轻量 diff：行级 LCS（首尾公共修剪 + 中段 DP，规模超限退化整块）→ 相邻增删行配对做行内字符级 LCS。
 * 供 AI 结果左右对比渲染；纯前端、无依赖，输入是普通字符串。
 */

export interface DiffSeg {
	text: string;
	kind: "plain" | "del" | "ins";
}

/** 一侧单元格：行号（空侧为 null）+ 行内字符级片段 */
export interface DiffCell {
	lineNo: number | null;
	segs: DiffSeg[];
}

/** 行类型：same 未变 / change 修改（左右配对）/ del 纯删除 / ins 纯新增 / fold 折叠占位 */
export type DiffRowKind = "same" | "change" | "del" | "ins" | "fold";

export interface DiffRow {
	kind: DiffRowKind;
	left: DiffCell;
	right: DiffCell;
	/** fold 行收纳的被折叠 same 行（点击展开后平铺渲染） */
	folded?: DiffRow[];
}

/** 折叠参数：变更块两侧各保留的上下文行数；中间未变行超过 FOLD_MIN_HIDDEN 才折叠 */
const FOLD_CONTEXT = 3;
const FOLD_MIN_HIDDEN = 6;

type SeqOp = { kind: "same" | "del" | "ins"; value: string };

/** 中段 DP 规模上限（n·m），超出退化为整块增删，避免内存爆炸 */
const LINE_BUDGET = 1_000_000;
/** 行内字符 diff 规模上限（n·m 字符） */
const CHAR_BUDGET = 250_000;

function splitLines(text: string): string[] {
	const normalized = text.replace(/\r\n?/g, "\n");
	return normalized === "" ? [] : normalized.split("\n");
}

/** 序列 diff（行或字符粒度通用）：O(n·m) DP，先修剪公共首尾把规模压到变更区 */
function diffSeq(a: string[], b: string[]): SeqOp[] {
	const ops: SeqOp[] = [];
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA -= 1;
		endB -= 1;
	}
	for (let i = 0; i < start; i += 1) ops.push({ kind: "same", value: a[i] });

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	if (midA.length !== 0 || midB.length !== 0) {
		if (midA.length === 0 || midB.length === 0 || midA.length * midB.length > LINE_BUDGET) {
			for (const v of midA) ops.push({ kind: "del", value: v });
			for (const v of midB) ops.push({ kind: "ins", value: v });
		} else {
			const n = midA.length;
			const m = midB.length;
			const width = m + 1;
			const dp = new Int32Array((n + 1) * width);
			for (let i = n - 1; i >= 0; i -= 1) {
				for (let j = m - 1; j >= 0; j -= 1) {
					dp[i * width + j] =
						midA[i] === midB[j]
							? dp[(i + 1) * width + j + 1] + 1
							: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
				}
			}
			let i = 0;
			let j = 0;
			while (i < n && j < m) {
				if (midA[i] === midB[j]) {
					ops.push({ kind: "same", value: midA[i] });
					i += 1;
					j += 1;
				} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
					ops.push({ kind: "del", value: midA[i] });
					i += 1;
				} else {
					ops.push({ kind: "ins", value: midB[j] });
					j += 1;
				}
			}
			while (i < n) {
				ops.push({ kind: "del", value: midA[i] });
				i += 1;
			}
			while (j < m) {
				ops.push({ kind: "ins", value: midB[j] });
				j += 1;
			}
		}
	}

	for (let i = endA; i < a.length; i += 1) ops.push({ kind: "same", value: a[i] });
	return ops;
}

/** 行内字符 diff：左列 del 片段（红中划线）/右列 ins 片段（绿底），公共字符两侧各留 plain */
function inlineDiff(oldLine: string, newLine: string): { left: DiffSeg[]; right: DiffSeg[] } {
	if (oldLine.length * newLine.length > CHAR_BUDGET) {
		return { left: [{ text: oldLine, kind: "del" }], right: [{ text: newLine, kind: "ins" }] };
	}
	// Array.from 按码点切分，避免中文无碍、emoji 被拦腰截断
	const charOps = diffSeq(Array.from(oldLine), Array.from(newLine));
	const left: DiffSeg[] = [];
	const right: DiffSeg[] = [];
	const push = (list: DiffSeg[], text: string, kind: DiffSeg["kind"]): void => {
		const last = list[list.length - 1];
		if (last && last.kind === kind) last.text += text;
		else list.push({ text, kind });
	};
	for (const op of charOps) {
		if (op.kind === "same") {
			push(left, op.value, "plain");
			push(right, op.value, "plain");
		} else if (op.kind === "del") {
			push(left, op.value, "del");
		} else {
			push(right, op.value, "ins");
		}
	}
	return { left, right };
}

/**
 * 左右两列对比（IDEA diff 风格）：每行带双侧行号；
 * 相邻 del/ins 逐行配对做行内字符 diff（change 行），剩余整行标记为 del/ins。
 * opts.fold=true（默认）时把长段未变行折叠成 fold 行，只保留变更块两侧的上下文。
 */
export function sideBySideDiff(
	oldText: string,
	newText: string,
	opts?: { fold?: boolean },
): DiffRow[] {
	const ops = diffSeq(splitLines(oldText), splitLines(newText));
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	const cell = (lineNo: number | null, segs: DiffSeg[]): DiffCell => ({ lineNo, segs });
	let idx = 0;
	while (idx < ops.length) {
		if (ops[idx].kind === "same") {
			oldNo += 1;
			newNo += 1;
			rows.push({
				kind: "same",
				left: cell(oldNo, [{ text: ops[idx].value, kind: "plain" }]),
				right: cell(newNo, [{ text: ops[idx].value, kind: "plain" }]),
			});
			idx += 1;
			continue;
		}
		// 收集连续的非 same 段（del 与 ins 混排）
		const dels: string[] = [];
		const ins: string[] = [];
		while (idx < ops.length && ops[idx].kind !== "same") {
			if (ops[idx].kind === "del") dels.push(ops[idx].value);
			else ins.push(ops[idx].value);
			idx += 1;
		}
		const pairs = Math.min(dels.length, ins.length);
		for (let k = 0; k < pairs; k += 1) {
			oldNo += 1;
			newNo += 1;
			const inline = inlineDiff(dels[k], ins[k]);
			rows.push({ kind: "change", left: cell(oldNo, inline.left), right: cell(newNo, inline.right) });
		}
		for (let k = pairs; k < dels.length; k += 1) {
			oldNo += 1;
			rows.push({ kind: "del", left: cell(oldNo, [{ text: dels[k], kind: "del" }]), right: cell(null, []) });
		}
		for (let k = pairs; k < ins.length; k += 1) {
			newNo += 1;
			rows.push({ kind: "ins", left: cell(null, []), right: cell(newNo, [{ text: ins[k], kind: "ins" }]) });
		}
	}
	return opts?.fold === false ? rows : foldSameRows(rows);
}

/** 把连续 same 行折叠成 fold 行：两端各留 FOLD_CONTEXT 行，中间藏进 folded */
function foldSameRows(rows: DiffRow[]): DiffRow[] {
	const out: DiffRow[] = [];
	let i = 0;
	while (i < rows.length) {
		if (rows[i].kind !== "same") {
			out.push(rows[i]);
			i += 1;
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j].kind === "same") j += 1;
		const run = j - i;
		if (run > FOLD_CONTEXT * 2 + FOLD_MIN_HIDDEN) {
			out.push(...rows.slice(i, i + FOLD_CONTEXT));
			const hidden = rows.slice(i + FOLD_CONTEXT, j - FOLD_CONTEXT);
			out.push({
				kind: "fold",
				left: { lineNo: null, segs: [] },
				right: { lineNo: null, segs: [] },
				folded: hidden,
			});
			out.push(...rows.slice(j - FOLD_CONTEXT, j));
		} else {
			out.push(...rows.slice(i, j));
		}
		i = j;
	}
	return out;
}
