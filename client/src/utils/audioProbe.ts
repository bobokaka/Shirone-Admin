/**
 * 客户端探测音频时长（秒）：Audio 元素 loadedmetadata + 超时兜底。
 * 部分容器（ogg 流）会给出 Infinity——一律视为失败，回退人工填写。
 */
export function probeAudioDuration(src: string, timeoutMs = 15_000): Promise<number | undefined> {
	return new Promise((resolve) => {
		const audio = new Audio();
		audio.preload = "metadata";
		const done = (v: number | undefined): void => {
			audio.onloadedmetadata = null;
			audio.onerror = null;
			clearTimeout(timer);
			resolve(v);
		};
		const timer = setTimeout(() => done(undefined), timeoutMs);
		audio.onloadedmetadata = () => {
			const d = audio.duration;
			done(Number.isFinite(d) && d > 0 ? Math.round(d) : undefined);
		};
		audio.onerror = () => done(undefined);
		audio.src = src;
	});
}
