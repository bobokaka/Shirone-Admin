/** 文章 frontmatter 与文件元信息 */
export interface PostMeta {
	/** 目录名（目录形式）或文件名去 .md（单文件形式） */
	slug: string;
	/** 相对 content/posts 的路径，统一 / 分隔（如 `hello/index.md`） */
	path: string;
	layout: "directory" | "file";
	title: string;
	/** YYYY-MM-DD */
	published: string;
	/** YYYY-MM-DDTHH:mm:ss+08:00 */
	publishedAt?: string;
	updated?: string;
	updatedAt?: string;
	description: string;
	image: string;
	category: string;
	tags: string[];
	pinned: boolean;
	draft: boolean;
	comment: boolean;
	encrypted: boolean;
	hasPassword: boolean;
	passwordHint: string;
	hideHomeContent: boolean;
	alias?: string;
	permalink?: string;
	/** 文件系统修改时间 YYYY-MM-DD HH:mm:ss（只读派生，不回写 frontmatter） */
	mtime?: string;
}

export interface PostFile {
	meta: PostMeta;
	body: string;
}

export interface MomentImage {
	src: string;
	alt: string;
}

export interface MomentMeta {
	/** 文件名去 .md（如 `20260906-183000`） */
	id: string;
	path: string;
	/** YYYY-MM-DD HH:mm:ss */
	published: string;
	pinned: boolean;
	location: string;
	/** Iconify 图标名 */
	mood: string;
	tags: string[];
	images: MomentImage[];
	draft: boolean;
	/** 正文文本（列表展示用） */
	body: string;
}

export interface MomentFile {
	meta: MomentMeta;
	body: string;
}

export interface GitStatus {
	branch: string;
	ahead: number;
	behind: number;
	staged: string[];
	modified: string[];
	untracked: string[];
}

/** git 操作目标仓：内容仓（../Shirone-Content）或主题仓（../Shirone） */
export type RepoTarget = "content" | "theme";

export interface SystemStatus {
	contentDir: string;
	themeDir: string;
	contentConnected: boolean;
	themeConnected: boolean;
	themeDepsInstalled: boolean;
	git: GitStatus | null;
}

/* ---------- 项目映射（内容仓/主题仓磁盘目录配置） ---------- */

/** 目录候选（AI 裁决或启发式扫描） */
export interface DirCandidate {
	path: string;
	/** 0-1 置信度 */
	confidence: number;
	/** 中文理由 */
	reason: string;
	/** ai = LLM 裁决；heuristic = 特征文件扫描 */
	source: "ai" | "heuristic";
}

export interface DirDetectResult {
	contentCandidates: DirCandidate[];
	themeCandidates: DirCandidate[];
	/** AI 是否参与裁决（未配置/未启用/失败时回退纯启发式） */
	aiUsed: boolean;
	/** AI 已配置但调用失败的原因（此时仍返回启发式结果） */
	aiError?: string;
	scannedDirs: number;
	elapsedMs: number;
}

export interface ProjectMappingStatus {
	contentDir: string;
	themeDir: string;
	/** workspace 相对默认路径（「恢复默认」回填用） */
	defaultContentDir: string;
	defaultThemeDir: string;
	/** 当前是否偏离默认 */
	contentCustom: boolean;
	themeCustom: boolean;
	contentConnected: boolean;
	themeConnected: boolean;
	themeDepsInstalled: boolean;
	/** AI 已启用且配置完整（「AI 查找」入口提示用） */
	aiEnabled: boolean;
}

export interface ProjectMappingSaveResult extends ProjectMappingStatus {
	/** 非阻断警示（目录缺失/特征不匹配等） */
	warnings: string[];
}

export interface FolderPickResult {
	canceled: boolean;
	folder?: string;
}

export interface CreatePostInput {
	title: string;
	slug?: string;
}

export interface SavePostInput {
	path: string;
	meta: Partial<PostMeta>;
	body: string;
	/** 仅在设置/修改密码时传；不传保留原值 */
	password?: string;
	/** true 时清除密码 */
	clearPassword?: boolean;
}

export interface MomentInput {
	/** YYYY-MM-DD HH:mm:ss */
	published: string;
	location?: string;
	mood?: string;
	tags?: string[];
	images?: MomentImage[];
	draft?: boolean;
	pinned?: boolean;
	body: string;
}

export interface MediaUploadResult {
	/** frontmatter 里应填的 src（文章配图为相对路径，说说为站点绝对路径） */
	src: string;
	fileName: string;
	/** 插入正文的建议 alt（文章配图为 图片<N>，与文件名编号一致） */
	alt?: string;
	batchId?: string;
}

export interface PublishPreview {
	branch: string;
	ahead: number;
	/** 落后远端的提交数（发布推送前会自动 rebase） */
	behind: number;
	files: string[];
	/** 带新增/修改状态的变更明细（files 的超集信息，发布页分组展示用） */
	changes: Array<{ path: string; state: "new" | "modified" }>;
	message: string;
	/** 主题仓待提交文件路径（未连接或无变更时为空数组） */
	themeFiles: string[];
	/** 主题仓变更明细（同 changes 结构；发布页主题仓 tab 展示用） */
	themeChanges: Array<{ path: string; state: "new" | "modified" }>;
	/** 主题仓按变更自动生成的提交信息（无变更时为空串） */
	themeMessage: string;
	themeDepsInstalled: boolean;
	/** 内容仓最近提交历史（发布页左栏面板；Admin 自身仓与此无关） */
	recent: Array<{ hash: string; date: string; subject: string }>;
	/** 主题仓最近提交（站点构建亦受其影响；未连接时为空） */
	themeRecent: Array<{ hash: string; date: string; subject: string }>;
	/** 主题仓状态（发布目标仓之一；未连接或非 git 仓时为 null） */
	themeStatus: GitStatus | null;
}

/** 落后远端轻量探测结果（git ls-remote 比对分支 tip，不拉取任何代码/对象） */
export interface RemoteProbe {
	/** 落后提交数：0=与远端一致；>0=按本地缓存的远端引用得出精确值；null=远端已前进但数量未知（需拉取） */
	behind: number | null;
}

/** 单仓发布结果（内容仓/主题仓各一份，两仓互不阻断） */
export interface RepoPublishResult {
	ok: boolean;
	/** 该仓执行时是否有待提交变更（false = 无变更或未连接而跳过） */
	hadChanges: boolean;
	commitHash?: string;
	pushed: boolean;
	/** 内容仓本地校验输出（校验失败时存在）；主题仓不跑本地校验 */
	validationOutput?: string;
	log: string[];
}

export interface PublishResult {
	content: RepoPublishResult;
	theme: RepoPublishResult;
	/** content.ok && theme.ok */
	ok: boolean;
}

export interface SlugSuggestion {
	slug: string;
	/** 非法字符被替换或发生去重时给出提示 */
	adjusted: boolean;
	note?: string;
}

/* ---------- 站点设置 ---------- */

export interface FaviconItem {
	src: string;
	theme: string;
}

export interface ProfileLink {
	name: string;
	icon: string;
	url: string;
}

export interface NavBarLink {
	preset?: string;
	name?: string;
	icon?: string;
	url?: string;
	external?: boolean;
	children?: NavBarLink[];
}

/** config/site.yaml 的类型化视图（全键可选，未声明键继承主题默认） */
export interface SiteSettings {
	site?: string;
	base?: string;
	title?: string;
	subtitle?: string;
	lang?: string;
	/** 站点国际化：enable=false 全站锁定简体中文；启用后 lang 需在 locales 内 */
	i18n?: {
		enable?: boolean;
		locales?: string[];
	};
	timeZone?: string;
	displaySettings?: Record<string, boolean>;
	themeColor?: {
		hue?: number;
		fixed?: boolean;
		style?: string;
		spec?: string;
	};
	wallpaperMode?: { defaultMode?: string };
	texture?: {
		enable?: boolean;
		defaultPreset?: string;
		defaultOpacity?: number;
		allowMotion?: boolean;
	};
	banner?: {
		src?: { desktop?: string[]; mobile?: string[] };
		position?: string;
		dim?: { enable?: boolean; opacity?: number };
		homeText?: {
			enable?: boolean;
			title?: string;
			subtitle?: string[];
			typewriter?: {
				enable?: boolean;
				speed?: number;
				deleteSpeed?: number;
				pauseTime?: number;
				loop?: boolean;
			};
		};
		carousel?: {
			enable?: boolean;
			interval?: number;
			fadeDuration?: number;
			animation?: string;
		};
		waves?: { enable?: boolean };
	};
	favicon?: FaviconItem[];
	/** 只读提示：主题默认 favicon，内容仓 favicon 未覆盖时的实际生效图标 */
	themeFavicon?: FaviconItem[];
}

export interface ProfileSettings {
	avatar?: string;
	name?: string;
	bio?: string;
	links?: ProfileLink[];
}

export interface FooterSettings {
	enable?: boolean;
	html?: string;
}

export interface SiteMediaResult {
	/** 写入 YAML 的 src（assets 为相对路径，favicon 为站点根绝对路径） */
	src: string;
	/** admin 内预览 URL（/content-assets 或 /content-public 前缀） */
	previewUrl: string;
	fileName: string;
}

/* ---------- 分类 / 标签 ---------- */

export type TaxonomyKind = "category" | "tag";

export interface TaxonomyRenameInput {
	kind: TaxonomyKind;
	from: string;
	/** 重命名/合并目标；空字符串 表示从所有文章中移除 */
	to: string;
}

export interface TaxonomyRenameResult {
	changed: number;
}

/* ---------- 结构化数据（data/*.ts）---------- */

export type DataKind =
	| "projects"
	| "skills"
	| "timeline"
	| "devices"
	| "anime"
	| "compass"
	| "music"
	| "friends";

export type DataItem = Record<string, unknown>;

/* ---------- AI 助手（Admin 工具本地配置，存 server/data，不进内容仓）---------- */

/** API 协议：anthropic 兼容（v1/messages，默认）或 openai 兼容（chat/completions） */
export type AiProtocol = "anthropic" | "openai";

/** 单个 AI 服务商（一套可切换的完整连接配置） */
export interface AiProviderConfig {
	/** 稳定 id（uuid），设置内部引用 */
	id: string;
	/** 显示名，如 Anthropic 官方 / GLM 中转 */
	name: string;
	/** API 协议（决定请求路径与鉴权头） */
	protocol: AiProtocol;
	/** API 根地址（官方或中转代理），如 https://api.anthropic.com 或 https://api.openai.com/v1 */
	baseUrl: string;
	/** API Key，仅保存在本机 server/data/ai-settings.json */
	apiKey: string;
	/** 主模型名，如 claude-sonnet-5 / gpt-4o-mini / glm-5.3 */
	model: string;
	/** 轻量模型名（摘要、字段生成等简单任务），留空表示同主模型 */
	modelFast: string;
	/** 允许给支持的服务附加联网检索工具；不支持时自动降级为普通请求 */
	webSearch: boolean;
	/** 采样温度 0-2 */
	temperature: number;
	/** 单次请求超时（秒） */
	timeoutSeconds: number;
}

export interface AiSettings {
	/** 总开关：关闭后所有 AI 辅助能力不可用 */
	enable: boolean;
	/** 已配置的服务商列表（至少一项），可新增/删除/切换 */
	providers: AiProviderConfig[];
	/** 当前生效的服务商 id（须指向 providers 中一项） */
	activeId: string;
}

export interface AiTestResult {
	ok: boolean;
	latencyMs: number;
	/** 测试请求的模型应答片段（ok 时存在） */
	reply?: string;
	/** 失败原因（ok=false 时存在） */
	error?: string;
}

export interface AiChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

export interface AiChatResult {
	content: string;
	model: string;
	promptTokens?: number;
	completionTokens?: number;
	/** 请求了联网检索时存在：true=带检索成功；false=服务不支持已降级为普通请求 */
	searchUsed?: boolean;
}

/* ---------- Bangumi（番剧元数据检索）---------- */

export interface BangumiCandidate {
	/** Bangumi subject id */
	id: number;
	/** 中文标题（无则原名） */
	title: string;
	originalTitle: string;
	/** 放送年份（YYYY，未知为空串） */
	year: string;
	/** Bangumi 图床封面 URL */
	cover?: string;
	summary: string;
	/** 总集数（未知为 0） */
	eps: number;
	/** Bangumi 评分（0-10） */
	bangumiScore?: number;
	/** 条目页链接 */
	link: string;
}

export interface BangumiDetail extends BangumiCandidate {
	/** 制作公司（infobox：动画制作/制作） */
	studio?: string;
	/** 放送档期（YYYY-MM） */
	period?: { start: string; end?: string };
	/** 高频类型标签（≤4 个） */
	genres: string[];
}

/* ---------- 音乐检索（版权感知导入）---------- */

export interface MusicLicenseInfo {
	/** 是否可免费商用 */
	freeCommercial: boolean;
	/** 一句话授权说明 */
	summary: string;
	/** 授权判定依据链接 */
	evidence?: string;
	/** 曲目来源页 */
	sourceUrl?: string;
}

export interface MusicSearchCandidate {
	title: string;
	artist?: string;
	license: MusicLicenseInfo;
	/** 可直接下载的音频直链（缺失时引导去来源页获取） */
	audioUrl?: string;
	coverUrl?: string;
}

/* ---------- 壁纸抓取（safebooru 图源，供横幅壁纸推荐）---------- */

export interface WallpaperCandidate {
	/** 图片直链（https，可直接下载） */
	imageUrl: string;
	/** 预览用小图直链（缺省回退 imageUrl） */
	previewUrl?: string;
	width?: number;
	height?: number;
}

/* ---------- 平台导入（简书官方导出包）---------- */

/** 导出包内一篇文章的清单项 */
export interface JianshuArticleRef {
	/** 会话内唯一 id（归一化后的包内相对路径，/ 分隔） */
	id: string;
	title: string;
	/** 压缩包内原始大小（字节） */
	bytes: number;
}

export interface JianshuNotebook {
	/** 文集名（包内顶层目录名；根级散文归入「未分组」） */
	name: string;
	articles: JianshuArticleRef[];
}

/** 上传导出包后的解析结果 */
export interface JianshuArchiveSummary {
	sessionId: string;
	notebooks: JianshuNotebook[];
	/** 文章总数 */
	total: number;
	/** 本会话已成功导入过的文章 id（重复导入提示用） */
	importedIds: string[];
}

/** 单篇转换预览（不落盘、图片保持远程链接） */
export interface JianshuPreview {
	title: string;
	markdown: string;
	imageCount: number;
	/** 正文纯文本字数（过小说明可能只剩占位内容） */
	wordCount: number;
}

export interface JianshuImportOptions {
	/** 统一发布日期 YYYY-MM-DD（导出包不含日期） */
	published: string;
	/** 用文集名作为文章分类 */
	categoryFromNotebook: boolean;
	/** categoryFromNotebook=false 时使用的分类（可空） */
	category?: string;
	tags: string[];
	/** 图片从简书 CDN 下载落仓（失败保留远程链接） */
	localizeImages: boolean;
	/** 导入为草稿（建议先过目再发布） */
	draft: boolean;
}

export interface JianshuImportResult {
	id: string;
	title: string;
	ok: boolean;
	/** 成功时内容仓内文章路径（如 `xxx/index.md`） */
	path?: string;
	error?: string;
	/** 成功本地化的图片数 */
	images: number;
}

export interface JianshuImportJob {
	id: string;
	sessionId: string;
	status: "running" | "done";
	total: number;
	done: number;
	/** 正在处理的文章标题 */
	current: string | null;
	results: JianshuImportResult[];
	/** 日志（保留末尾 200 条） */
	log: string[];
}

/* ---------- 单篇粘贴导入（网页版复制内容，无会话）---------- */

/** 粘贴载荷：富文本（text/html）优先，纯文本按 markdown 兜底；markdown 为编辑器定稿（导入时优先采用） */
export interface JianshuPasteInput {
	html?: string;
	text?: string;
	markdown?: string;
}

export interface JianshuPasteOptions {
	title: string;
	/** YYYY-MM-DD */
	published: string;
	category?: string;
	tags: string[];
	draft: boolean;
}

/** 单篇粘贴导入结果 */
export interface JianshuPasteResult {
	title: string;
	/** 内容仓内文章路径（如 `xxx/index.md`） */
	path: string;
	slug: string;
	/** 成功下载到文章目录的图片数 */
	images: number;
	/** 下载失败、正文保留远程链接的图片 */
	failedImages: string[];
}

/** AI 分析出的博客补充元信息（粘贴导入「文章信息」步回填）；aiUsed=false 表示未启用/失败，已回退正文摘要 */
export interface JianshuMetaSuggestion {
	/** AI 拟定的标题（用户未提供时；回退路径无此字段） */
	title?: string;
	description: string;
	category: string;
	tags: string[];
	aiUsed: boolean;
}
