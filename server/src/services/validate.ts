import { execa } from "execa";
import { CONTENT_DIR, THEME_DIR, THEME_SYNC_SCRIPT, themeDepsInstalled } from "../config.js";
import { ApiError } from "../lib/errors.js";

export interface DryValidation {
	ok: boolean;
	output: string;
}

/**
 * 复用主题仓的 `sync --dry-run`（等价 pnpm content:validate）：
 * 纯内存预检 YAML 格式/字段拼写/frontmatter schema，不落盘。
 */
export async function runDryValidation(): Promise<DryValidation> {
	if (!themeDepsInstalled()) {
		throw new ApiError(400, "主题仓 node_modules 未安装，无法执行本地校验（先在 Shirone/ 下 pnpm install）");
	}
	const r = await execa(process.execPath, [THEME_SYNC_SCRIPT, "--dry-run"], {
		cwd: THEME_DIR,
		env: { ...process.env, CONTENT_DIR },
		reject: false,
		all: true,
		timeout: 180_000,
	});
	const output = (r.all ?? "").slice(-4000);
	return { ok: r.exitCode === 0, output };
}
