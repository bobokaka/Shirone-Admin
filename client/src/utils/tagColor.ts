/** 标签名 → 稳定色相：同名标签在任意位置同色 */
function hueOf(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return h % 360;
}

/** 彩色标签样式（浅底深字，适配浅色主题） */
export function tagColorStyle(name: string): Record<string, string> {
	const h = hueOf(name);
	return {
		backgroundColor: `hsl(${h} 75% 88%)`,
		borderColor: `hsl(${h} 65% 78%)`,
		color: `hsl(${h} 55% 30%)`,
	};
}

/** 彩色分类卡片样式（比标签深一档，配方形圆角，用于列表卡片的分类位） */
export function categoryCardStyle(name: string): Record<string, string> {
	const h = hueOf(name);
	return {
		backgroundColor: `hsl(${h} 70% 82%)`,
		borderColor: `hsl(${h} 60% 70%)`,
		color: `hsl(${h} 55% 26%)`,
	};
}
