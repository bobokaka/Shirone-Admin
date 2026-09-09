/**
 * 导航预设目录：镜像主题仓 `src/config/navBarConfig.ts` 的 `LinkPresets`，
 * 提供中文（English）标签、路径说明与图标，主题新增预设时同步维护。
 */
export interface NavPresetMeta {
	/** 写入 nav-bar.yaml 的 preset 值（英文标识） */
	value: string;
	/** 「中文（English）」双语标签 */
	label: string;
	/** 路径 / 用途说明 */
	desc: string;
	/** 主题内置图标 */
	icon: string;
}

export const NAV_PRESETS: NavPresetMeta[] = [
	{ value: "Home", label: "首页（Home）", desc: "/ · 站点首页", icon: "material-symbols:home-outline-rounded" },
	{ value: "Archive", label: "归档（Archive）", desc: "/archive/ · 全部文章归档", icon: "material-symbols:archive-outline-rounded" },
	{ value: "Friends", label: "友链（Friends）", desc: "/friends/ · 友情链接页", icon: "material-symbols:handshake-outline-rounded" },
	{ value: "Moments", label: "说说（Moments）", desc: "/moments/ · 动态朋友圈", icon: "material-symbols:auto-awesome-outline-rounded" },
	{ value: "Anime", label: "番剧（Anime）", desc: "/anime/ · 追番记录", icon: "material-symbols:live-tv-outline-rounded" },
	{ value: "Compass", label: "指南针（Compass）", desc: "/compass/ · 网址导航", icon: "material-symbols:explore-rounded" },
	{ value: "Skills", label: "技能（Skills）", desc: "/skills/ · 技能展示", icon: "material-symbols:workspaces-outline-rounded" },
	{ value: "Projects", label: "项目（Projects）", desc: "/projects/ · 项目展示", icon: "material-symbols:deployed-code-outline-rounded" },
	{ value: "Devices", label: "设备（Devices）", desc: "/devices/ · 设备清单", icon: "material-symbols:devices-rounded" },
	{ value: "Timeline", label: "时间线（Timeline）", desc: "/timeline/ · 个人时间线", icon: "material-symbols:timeline-rounded" },
	{ value: "Albums", label: "相册（Albums）", desc: "/albums/ · 图片相册", icon: "material-symbols:photo-library-outline-rounded" },
	{ value: "Categories", label: "分类（Categories）", desc: "/categories/ · 文章分类索引", icon: "material-symbols:folder-outline-rounded" },
	{ value: "Tags", label: "标签（Tags）", desc: "/tags/ · 文章标签索引", icon: "material-symbols:tag-rounded" },
	{ value: "About", label: "关于（About）", desc: "/about/ · 关于本站", icon: "material-symbols:info-outline-rounded" },
	{ value: "GitHub", label: "GitHub", desc: "主题源码仓库 · 外部链接", icon: "fa6-brands:github" },
];

/** 按 preset 值查元数据；未收录返回 null（自定义/拼写错误名） */
export function navPresetOf(value: string | undefined): NavPresetMeta | null {
	if (!value) return null;
	return NAV_PRESETS.find((p) => p.value === value) ?? null;
}
