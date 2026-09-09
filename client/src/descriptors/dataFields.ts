import type { DataKind } from "@shirone-admin/shared";

export type DataFieldType =
	| "text"
	| "textarea"
	| "number"
	| "boolean"
	| "enum"
	| "string[]"
	| "json"
	| "image"
	| "progress"
	/** Iconify 名或图片路径，表格/编辑均渲染为图标（DataIcon 四态） */
	| "icon"
	/** 头像 URL（友链 imgurl）：表格额外渲染方形头像列，同时保留 URL 文本列 */
	| "avatar"
	/** 条目列表（罗盘导航/时间线链接）：列表渲染为标签组、编辑用可视化卡片（EntryListEditor） */
	| "entries"
	/** 日期字符串：日精度选择器（时间线 date，YYYY.MM.DD 点分日格式） */
	| "date";

/** 条目列表字段的子字段配置（EntryListEditor 渲染与保存清洗共用） */
export interface EntrySubField {
	key: string;
	label: string;
	type: "text" | "icon";
	required?: boolean;
	placeholder?: string;
	/** 编辑卡片两列网格中的占列：1 半行 / 2 整行（默认 1） */
	span?: 1 | 2;
}

/** 条目列表草稿（罗盘导航条目 / 时间线链接的元素）；未知键保存时原样保留 */
export interface EntryDraft {
	[key: string]: unknown;
}

export interface DataFieldDescriptor {
	key: string;
	label: string;
	type: DataFieldType;
	enumValues?: Array<{ value: string; label: string }>;
	required?: boolean;
	placeholder?: string;
	/** 表格中隐藏，只在编辑弹窗出现 */
	hideInTable?: boolean;
	/** 新增时自动取 max+1（friends.id） */
	autoId?: boolean;
	/**
	 * 标识类字段（字符串）：表格与新增/编辑表单都不显示，
	 * 新增时由标题自动生成拼音 slug（重名加序号），编辑保留原值。
	 */
	autoKey?: boolean;
	/**
	 * 键值字段的中文显示映射（key 原样入库，界面显示/选择用中文 label）。
	 * 与内容仓 config/*.yaml 的 categories 对齐；未知值原样显示。
	 */
	displayMap?: Record<string, string>;
	/** 条目列表（type === "entries"）的子字段配置 */
	itemFields?: EntrySubField[];
	/** 字段级 AI 入口：编辑弹窗 textarea 右上角出现 ✨ 按钮（AI 未启用时隐藏） */
	ai?: boolean;
}

export interface DataKindDescriptor {
	kind: DataKind;
	label: string;
	/** 单条条目的称呼，如「项目」 */
	itemLabel: string;
	fields: DataFieldDescriptor[];
	/** 表格第一列使用的字段 key（默认取第一个字段） */
	titleKey?: string;
	/** 标题列后括号附注的字段 key（如书架名称后附 (frontend)），该字段需 hideInTable */
	titleSuffixKey?: string;
}

function enums(values: Array<[string, string]>): Array<{ value: string; label: string }> {
	return values.map(([value, label]) => ({ value, label }));
}

/** 分类键 → 中文标签（与内容仓 config/*.yaml 的 categories 清单对齐） */
const CATEGORY_MAPS = {
	skills: {
		frontend: "前端",
		backend: "后端",
		tooling: "工具",
		gamedev: "游戏开发",
	},
	projects: {
		theme: "主题",
		app: "应用",
		finance: "金融",
		tool: "工具",
	},
	timeline: {
		milestone: "里程碑",
		project: "项目",
		career: "经历",
		life: "生活",
	},
} as const;

export const DATA_DESCRIPTORS: DataKindDescriptor[] = [
	{
		kind: "projects",
		label: "项目",
		itemLabel: "项目",
		titleKey: "title",
		fields: [
			{ key: "key", label: "标识 key", type: "text", autoKey: true },
			{ key: "title", label: "名称", type: "text", required: true },
			{ key: "summary", label: "简介", type: "textarea", ai: true },
			{ key: "category", label: "分类", type: "text", displayMap: { ...CATEGORY_MAPS.projects } },
			{
				key: "phase",
				label: "阶段",
				type: "enum",
				enumValues: enums([
					["shipped", "已发布"],
					["building", "开发中"],
					["exploring", "探索中"],
				]),
			},
			{ key: "technologies", label: "技术栈", type: "string[]", placeholder: "输入后回车" },
			{ key: "featured", label: "精选", type: "boolean" },
			{ key: "icon", label: "图标", type: "icon", hideInTable: true, placeholder: "material-symbols:…" },
			{ key: "repository", label: "仓库地址", type: "text", hideInTable: true },
			{ key: "website", label: "网站", type: "text", hideInTable: true },
			{ key: "year", label: "年份", type: "text", hideInTable: true },
			{ key: "cover", label: "封面", type: "text", hideInTable: true },
			{ key: "coverAlt", label: "封面描述", type: "text", hideInTable: true },
			{ key: "enable", label: "启用", type: "boolean", hideInTable: true },
		],
	},
	{
		kind: "skills",
		label: "技能",
		itemLabel: "技能",
		titleKey: "name",
		fields: [
			{ key: "name", label: "名称", type: "text", required: true },
			{ key: "category", label: "分类", type: "text", displayMap: { ...CATEGORY_MAPS.skills } },
			{
				key: "level",
				label: "水平",
				type: "enum",
				enumValues: enums([
					["beginner", "入门"],
					["intermediate", "熟练"],
					["advanced", "精通"],
					["expert", "专家"],
				]),
			},
			{ key: "description", label: "描述", type: "textarea", ai: true },
			{ key: "icon", label: "图标", type: "icon", hideInTable: true, placeholder: "simple-icons:typescript" },
			{ key: "enable", label: "启用", type: "boolean", hideInTable: true },
		],
	},
	{
		kind: "timeline",
		label: "时间线",
		itemLabel: "事件",
		titleKey: "title",
		fields: [
			{ key: "title", label: "标题", type: "text", required: true },
			{ key: "date", label: "日期", type: "date", required: true },
			{ key: "category", label: "分类", type: "text", displayMap: { ...CATEGORY_MAPS.timeline } },
			{ key: "subtitle", label: "副标题", type: "text" },
			{ key: "location", label: "地点", type: "text", hideInTable: true },
			{ key: "description", label: "描述", type: "textarea", hideInTable: true, ai: true },
			{ key: "highlights", label: "要点", type: "string[]" },
			{ key: "tags", label: "标签", type: "string[]", hideInTable: true },
			{
				key: "links",
				label: "关联链接",
				type: "entries",
				hideInTable: true,
				itemFields: [
					{ key: "label", label: "名称", type: "text", required: true, placeholder: "如 主题源码" },
					{ key: "icon", label: "图标", type: "icon", placeholder: "Iconify 名，如 fa6-brands:github" },
					{ key: "url", label: "地址", type: "text", required: true, span: 2, placeholder: "https://…" },
				],
			},
			{ key: "icon", label: "图标", type: "icon", hideInTable: true },
			{ key: "featured", label: "精选", type: "boolean", hideInTable: true },
			{ key: "enable", label: "启用", type: "boolean", hideInTable: true },
		],
	},
	{
		kind: "devices",
		label: "设备",
		itemLabel: "设备",
		titleKey: "name",
		fields: [
			{ key: "id", label: "标识 id", type: "text", autoKey: true },
			{ key: "name", label: "名称", type: "text", required: true },
			{ key: "brand", label: "品牌", type: "text" },
			{
				key: "category",
				label: "分类",
				type: "enum",
				enumValues: enums([
					["desk", "PC"],
					["mobile", "移动设备"],
					["audio", "影音音频"],
					["peripheral", "外设配件"],
				]),
			},
			{
				key: "status",
				label: "状态",
				type: "enum",
				enumValues: enums([
					["active", "在用"],
					["backup", "备用"],
					["archived", "退役"],
					["wishlist", "想买"],
				]),
			},
			{ key: "specs", label: "规格", type: "text", placeholder: "M3 Max / 64GB / 2TB" },
			{ key: "description", label: "描述", type: "textarea", hideInTable: true, ai: true },
			{
				key: "specDetails",
				label: "规格明细",
				type: "json",
				hideInTable: true,
				placeholder: '[{"key":"cpu","label":"CPU","value":"M3 Max"}]',
			},
			{ key: "icon", label: "图标", type: "icon", hideInTable: true },
			{ key: "image", label: "图片", type: "text", hideInTable: true },
			{ key: "link", label: "链接", type: "text", hideInTable: true },
			{ key: "year", label: "年份", type: "text", hideInTable: true },
			{ key: "featured", label: "精选", type: "boolean", hideInTable: true },
			{ key: "enable", label: "启用", type: "boolean", hideInTable: true },
		],
	},
	{
		kind: "anime",
		label: "番剧",
		itemLabel: "番剧",
		titleKey: "title",
		fields: [
			{ key: "title", label: "标题", type: "text", required: true },
			{ key: "year", label: "年份", type: "text" },
			{
				key: "status",
				label: "状态",
				type: "enum",
				enumValues: enums([
					["watching", "在看"],
					["completed", "看完"],
					["planned", "计划"],
					["onHold", "搁置"],
					["dropped", "弃番"],
				]),
			},
			{ key: "rating", label: "评分", type: "number", placeholder: "0 - 10" },
			{
				key: "progress",
				label: "进度",
				type: "progress",
			},
			{ key: "genres", label: "类型", type: "string[]" },
			{ key: "description", label: "描述", type: "textarea", ai: true },
			{ key: "cover", label: "封面", type: "image" },
			{ key: "studio", label: "制作", type: "text" },
			{ key: "link", label: "链接", type: "text", hideInTable: true },
			{ key: "period", label: "档期", type: "json", hideInTable: true, placeholder: '{"start":"2023-06","end":"2023-09"}' },
		],
	},
	{
		kind: "compass",
		label: "罗盘",
		itemLabel: "书架",
		titleKey: "name",
		titleSuffixKey: "key",
		fields: [
			{ key: "key", label: "标识 key", type: "text", autoKey: true },
			{ key: "name", label: "名称", type: "text", required: true },
			{ key: "icon", label: "图标", type: "icon" },
			{ key: "blurb", label: "简介", type: "text" },
			{
				key: "entries",
				label: "导航条目",
				type: "entries",
				itemFields: [
					{ key: "label", label: "名称", type: "text", required: true, placeholder: "如 MDN Web Docs" },
					{ key: "href", label: "链接", type: "text", required: true, placeholder: "https://…" },
					{ key: "note", label: "备注", type: "text", placeholder: "一行说明，缺省显示域名" },
					{ key: "icon", label: "图标", type: "icon", placeholder: "图片路径或 Iconify 名" },
				],
			},
		],
	},
	{
		kind: "music",
		label: "歌单",
		itemLabel: "曲目",
		titleKey: "title",
		fields: [
			{ key: "id", label: "曲目 id", type: "text", autoKey: true },
			{ key: "title", label: "曲名", type: "text", required: true },
			{ key: "artist", label: "艺术家", type: "text" },
			{ key: "cover", label: "封面", type: "image", hideInTable: true },
			{ key: "source", label: "音频地址", type: "text", required: true, hideInTable: true, placeholder: "/assets/music/url/xx.mp3" },
			{ key: "duration", label: "时长", type: "number", placeholder: "秒数，如 194" },
		],
	},
	{
		kind: "friends",
		label: "友链",
		itemLabel: "友链",
		titleKey: "title",
		fields: [
			{ key: "id", label: "ID", type: "number", autoId: true, hideInTable: true },
			{ key: "title", label: "站点名", type: "text", required: true },
			{ key: "imgurl", label: "头像URL", type: "avatar", placeholder: "https://…/avatar.png" },
			{ key: "desc", label: "描述", type: "textarea", ai: true },
			{ key: "siteurl", label: "地址", type: "text", required: true },
			{ key: "tags", label: "标签", type: "string[]" },
		],
	},
];

export function descriptorOf(kind: DataKind): DataKindDescriptor {
	const d = DATA_DESCRIPTORS.find((x) => x.kind === kind);
	if (!d) throw new Error(`未知数据类型：${kind}`);
	return d;
}

export function tableFields(d: DataKindDescriptor): DataFieldDescriptor[] {
	return d.fields.filter((f) => !f.hideInTable && !f.autoKey);
}
