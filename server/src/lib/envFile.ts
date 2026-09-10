import fs from "node:fs/promises";

/**
 * .env 行级编辑：只动目标键的活动行，其余行（注释、空行、无关键）原样保留，
 * CRLF 自动探测。不引 dotenv——与 config.ts 的 process.loadEnvFile 保持同一极简口径。
 * value 为 null 表示删除该键（恢复默认）。
 */
export async function updateEnvFile(
	envPath: string,
	updates: Record<string, string | null>,
): Promise<void> {
	const text = await fs.readFile(envPath, "utf8").catch(() => "");
	const eol = text.includes("\r\n") ? "\r\n" : "\n";
	const pending = new Map(Object.entries(updates));
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		// 只认未注释的活动赋值行，.env.example 式注释模板不会被误改
		const m = line.match(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/);
		if (m && pending.has(m[1])) {
			const value = pending.get(m[1])!;
			pending.delete(m[1]);
			if (value !== null) out.push(`${m[1]}=${value}`);
		} else {
			out.push(line);
		}
	}
	for (const [key, value] of pending) {
		if (value !== null) out.push(`${key}=${value}`);
	}
	const next = out.join(eol);
	await fs.writeFile(envPath, next === "" || next.endsWith(eol) ? next : `${next}${eol}`, "utf8");
}
