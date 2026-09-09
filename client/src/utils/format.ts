/** 秒数 → 00:28 / 03:14 / 1:02:58；非法值返回 — */
export function formatDuration(sec: number): string {
	if (!Number.isFinite(sec) || sec < 0) return "—";
	const s = Math.round(sec);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = s % 60;
	const mm = String(m).padStart(2, "0");
	const ss = String(r).padStart(2, "0");
	return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
