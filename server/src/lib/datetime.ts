export const TZ = "Asia/Shanghai";

const partsFmt = new Intl.DateTimeFormat("en-CA", {
	timeZone: TZ,
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false,
});

function parts(d: Date): Record<string, string> {
	const out: Record<string, string> = {};
	for (const p of partsFmt.formatToParts(d)) out[p.type] = p.value;
	return out;
}

/** Date → Asia/Shanghai 日历日期 YYYY-MM-DD */
export function shanghaiDate(d: Date): string {
	const p = parts(d);
	return `${p.year}-${p.month}-${p.day}`;
}

export function todayShanghai(): string {
	return shanghaiDate(new Date());
}

/** Date → YYYY-MM-DD HH:mm:ss（Asia/Shanghai，说说 frontmatter 格式） */
export function shanghaiMomentStamp(d = new Date()): string {
	const p = parts(d);
	return `${p.year}-${p.month}-${p.day} ${p.hour === "24" ? "00" : p.hour}:${p.minute}:${p.second}`;
}

/** YYYY-MM-DD HH:mm:ss → yyyymmdd-HHmmss（说说文件标识） */
export function momentId(published: string): string {
	const digits = published.replace(/\D/g, "");
	return `${digits.slice(0, 8)}-${digits.slice(8, 14)}`;
}

/** publishedAt 字符串在 Asia/Shanghai 下的日历日期；解析失败返回 null */
export function shanghaiDateOfDatetime(value: string): string | null {
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return null;
	return shanghaiDate(d);
}

/** 校验 published/publishedAt 时区一致性（主题构建硬规则） */
export function checkDateTimeConsistency(
	published: string,
	publishedAt?: string,
): { ok: boolean; message?: string } {
	if (!publishedAt) return { ok: true };
	if (!/^\d{4}-\d{2}-\d{2}$/.test(published)) {
		return { ok: false, message: `published 必须是 YYYY-MM-DD，当前为「${published}」` };
	}
	const actual = shanghaiDateOfDatetime(publishedAt);
	if (actual === null) {
		return { ok: false, message: `publishedAt 无法解析：${publishedAt}` };
	}
	if (actual !== published) {
		return {
			ok: false,
			message: `时区不一致：publishedAt 在 Asia/Shanghai 下是 ${actual}，与 published（${published}）不符`,
		};
	}
	return { ok: true };
}
