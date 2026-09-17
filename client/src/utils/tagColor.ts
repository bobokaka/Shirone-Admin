/** 标签名 → 稳定色相：同名标签在任意位置同色 */
function hueOf(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return h % 360;
}

/** 彩色标签样式（饱和度 / 亮度走 styles.css 的 --tag-* 变量，明暗主题自动切换） */
export function tagColorStyle(name: string): Record<string, string> {
	const h = hueOf(name);
	return {
		backgroundColor: `hsl(${h} var(--tag-s) var(--tag-bg-l))`,
		borderColor: `hsl(${h} var(--tag-s) var(--tag-border-l))`,
		color: `hsl(${h} var(--tag-s) var(--tag-text-l))`,
	};
}

/** 彩色分类卡片样式（比标签深一档，配方形圆角，用于列表卡片的分类位） */
export function categoryCardStyle(name: string): Record<string, string> {
	const h = hueOf(name);
	return {
		backgroundColor: `hsl(${h} var(--cat-s) var(--cat-bg-l))`,
		borderColor: `hsl(${h} var(--cat-s) var(--cat-border-l))`,
		color: `hsl(${h} var(--cat-s) var(--cat-text-l))`,
	};
}
