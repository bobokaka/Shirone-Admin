import type {
	AiChatResult,
	AiSettings,
	AiTestResult,
	BangumiCandidate,
	BangumiDetail,
	CreatePostInput,
	DataItem,
	DataKind,
	DirDetectResult,
	FolderPickResult,
	FooterSettings,
	GitStatus,
	JianshuArchiveSummary,
	JianshuImportJob,
	JianshuImportOptions,
	JianshuMetaSuggestion,
	JianshuPasteOptions,
	JianshuPasteResult,
	JianshuPreview,
	MediaUploadResult,
	MomentFile,
	MomentInput,
	MomentMeta,
	MusicSearchCandidate,
	NavBarLink,
	PostFile,
	PostMeta,
	ProjectMappingSaveResult,
	ProjectMappingStatus,
	ProfileSettings,
	PublishPreview,
	PublishResult,
	RemoteProbe,
	RepoTarget,
	SiteMediaResult,
	SiteSettings,
	SlugSuggestion,
	SystemStatus,
	TaxonomyRenameInput,
	TaxonomyRenameResult,
	WallpaperCandidate,
} from "@shirone-admin/shared";
import { api } from "./client";
import type { TimelineDraftPayload } from "../types/imports";

export interface ValidationOutcome {
	ok: boolean;
	output: string;
}

export const systemApi = {
	status: () => api.get<SystemStatus>("/api/status"),
	previewStart: () => api.post<{ started: boolean; message: string }>("/api/preview/start"),
	previewStop: () => api.post<{ stopped: boolean }>("/api/preview/stop"),
	previewStatus: () =>
		api.get<{ running: boolean; ready: boolean; procs: string[] }>("/api/preview/status"),
	/** 项目映射：内容仓/主题仓目录（保存后热生效） */
	mapping: () => api.get<ProjectMappingStatus>("/api/system/mapping"),
	saveMapping: (input: { contentDir?: string | null; themeDir?: string | null }) =>
		api.put<ProjectMappingSaveResult>("/api/system/mapping", input),
	/** 系统文件夹选择对话框（Windows）；取消返回 canceled */
	pickFolder: (title?: string) => api.post<FolderPickResult>("/api/system/pick-folder", { title }),
	/** 目录探测：特征扫描 + AI 裁决（AI 未配置/失败回退扫描） */
	detectDirs: () => api.post<DirDetectResult>("/api/system/detect-dirs", {}),
};

export const postApi = {
	list: () => api.get<PostMeta[]>("/api/posts"),
	detail: (path: string) => api.get<PostFile>(`/api/posts/detail?path=${encodeURIComponent(path)}`),
	create: (input: CreatePostInput) => api.post<PostFile>("/api/posts", input),
	save: (input: {
		path: string;
		meta: Record<string, unknown>;
		body: string;
		password?: string;
		clearPassword?: boolean;
	}) => api.put<PostFile>("/api/posts", input),
	remove: (path: string) => api.del<{ ok: boolean }>(`/api/posts?path=${encodeURIComponent(path)}`),
	slug: (title: string, slug?: string) =>
		api.post<SlugSuggestion>("/api/slug", { title, slug }),
};

export const momentApi = {
	list: () => api.get<MomentMeta[]>("/api/moments"),
	detail: (path: string) =>
		api.get<MomentFile>(`/api/moments/detail?path=${encodeURIComponent(path)}`),
	create: (input: MomentInput) => api.post<MomentFile>("/api/moments", input),
	update: (path: string, input: MomentInput) => api.put<MomentFile>("/api/moments", { path, ...input }),
	remove: (path: string) => api.del<{ ok: boolean }>(`/api/moments?path=${encodeURIComponent(path)}`),
};

export const mediaApi = {
	postImage: (slug: string, file: File) => {
		const form = new FormData();
		form.append("slug", slug);
		form.append("file", file);
		return api.upload<MediaUploadResult>("/api/media/post-image", form);
	},
	momentImage: (batchId: string | undefined, file: File) => {
		const form = new FormData();
		if (batchId) form.append("batchId", batchId);
		form.append("file", file);
		return api.upload<MediaUploadResult>("/api/media/moment-image", form);
	},
	/** 站点图片：name 为固定文件名（favicon 槽位定名替换）；currentSrc 为字段当前值（指向同目录时原位替换） */
	siteImage: (target: string, file: File, opts?: { name?: string; currentSrc?: string }) => {
		const form = new FormData();
		form.append("target", target);
		if (opts?.name) form.append("name", opts.name);
		if (opts?.currentSrc) form.append("currentSrc", opts.currentSrc);
		form.append("file", file);
		return api.upload<SiteMediaResult>("/api/media/site-image", form);
	},
	/** 站点图片在线导入：服务端代取远程直链落仓，站点不依赖外部地址 */
	siteImageImport: (input: { target: string; url: string; name?: string; currentSrc?: string }) =>
		api.post<SiteMediaResult>("/api/media/site-image-import", input),
	/** 站点图片托管目录清单（页脚图片库） */
	siteImages: (target: string) => api.get<SiteMediaResult[]>(`/api/media/site-images?target=${encodeURIComponent(target)}`),
	/** 数据条目封面：kind 决定目录；path 为当前值时原位覆盖（替换图片） */
	dataCover: (kind: DataKind, path: string, file: File) => {
		const form = new FormData();
		form.append("kind", kind);
		if (path.trim() !== "") form.append("path", path.trim());
		form.append("file", file);
		return api.upload<SiteMediaResult>("/api/media/data-cover", form);
	},
};

/** 歌单导入：本地/远程音频落仓与远程封面导入 */
export const musicApi = {
	/** currentSrc 命中托管目录时原位替换旧音频 */
	uploadAudio: (file: File, currentSrc?: string) => {
		const form = new FormData();
		if (currentSrc) form.append("currentSrc", currentSrc);
		form.append("file", file);
		return api.upload<SiteMediaResult>("/api/media/music-audio", form);
	},
	/** 服务端代取远程音频直链（浏览器跨源拿不到的场景） */
	downloadAudio: (input: { url: string; filename?: string; currentPath?: string }) =>
		api.post<SiteMediaResult>("/api/media/music-download", input),
	/** 远程封面（AI 检索出的 CDN 地址等）→ 数据类型对应封面目录 */
	coverImport: (input: { kind: DataKind; url: string; title?: string; currentPath?: string }) =>
		api.post<SiteMediaResult>("/api/media/data-cover-import", input),
};

export const settingsApi = {
	getSite: () => api.get<SiteSettings>("/api/settings/site"),
	saveSite: (input: Partial<SiteSettings>) => api.put<SiteSettings>("/api/settings/site", input),
	getProfile: () => api.get<ProfileSettings>("/api/settings/profile"),
	saveProfile: (input: Partial<ProfileSettings>) => api.put<ProfileSettings>("/api/settings/profile", input),
	getNavbar: () => api.get<{ links?: NavBarLink[] }>("/api/settings/navbar"),
	saveNavbar: (input: { links?: NavBarLink[] }) =>
		api.put<{ links?: NavBarLink[] }>("/api/settings/navbar", input),
	getFooter: () => api.get<FooterSettings>("/api/settings/footer"),
	saveFooter: (input: Partial<FooterSettings>) => api.put<FooterSettings>("/api/settings/footer", input),
};

export const publishApi = {
	preview: () => api.get<PublishPreview>("/api/publish/preview"),
	/** 轻量比对远端（ls-remote，不拉取代码）：是否落后、落后多少 */
	probeRepo: (repo: "content" | "theme") => api.post<RemoteProbe>("/api/publish/probe", { repo }),
	run: (input: { contentMessage?: string; themeMessage?: string }) =>
		api.post<PublishResult>("/api/publish", input),
	validate: () => api.post<ValidationOutcome>("/api/validate"),
};

export const dataApi = {
	get: (kind: DataKind) => api.get<{ kind: DataKind; items: DataItem[] }>(`/api/data/${kind}`),
	save: (kind: DataKind, items: DataItem[]) =>
		api.put<{ ok: boolean; changed: boolean }>(`/api/data/${kind}`, { items }),
};

export const taxonomyApi = {
	rename: (input: TaxonomyRenameInput) =>
		api.post<TaxonomyRenameResult>("/api/taxonomy/rename", input),
};

export const aiApi = {
	getSettings: () => api.get<AiSettings>("/api/ai/settings"),
	saveSettings: (input: AiSettings) => api.put<AiSettings>("/api/ai/settings", input),
	/** 传表单当前值可先测后存；不传则用已保存配置 */
	test: (input?: AiSettings) => api.post<AiTestResult>("/api/ai/test", input),
	chat: (
		messages: { role: "system" | "user" | "assistant"; content: string }[],
		maxTokens?: number,
		opts?: { fast?: boolean },
	) => api.post<AiChatResult>("/api/ai/chat", { messages, maxTokens, fast: opts?.fast }),
	edit: (instruction: string, text: string, opts?: { maxTokens?: number }) =>
		api.post<AiChatResult>("/api/ai/edit", { instruction, text, maxTokens: opts?.maxTokens }),
	/** 音乐版权检索（联网优先）；searchUsed=false 表示服务不支持联网，结果可信度低 */
	musicSearch: (query: string) =>
		api.post<{ candidates: MusicSearchCandidate[]; searchUsed: boolean }>("/api/ai/music-search", { query }),
	/** 壁纸抓取（safebooru 二次元图源）；target=desktop|mobile，候选凑满一批 */
	wallpaperSearch: (query: string, target: "desktop" | "mobile") =>
		api.post<{ candidates: WallpaperCandidate[] }>("/api/ai/wallpaper-search", {
			query,
			target,
		}),
	/** AI 生成提交信息（repo 指定按哪仓变更生成）；source=heuristic 表示 AI 失败/不合规已回退启发式 */
	commitMessage: (repo: RepoTarget = "content") =>
		api.post<{ message: string; source: "ai" | "heuristic" }>("/api/ai/commit-message", { repo }),
	/** 时间线事件 AI 起草：git 扫描三仓提交历史 / note 按描述起草；existing 传已收录事件用于去重 */
	timelineDraft: (input: {
		mode: "note" | "git";
		note?: string;
		limit?: number;
		existing?: Array<{ title: string; date: string }>;
	}) => api.post<{ events: TimelineDraftPayload[]; duplicated: number }>("/api/ai/timeline-draft", input),
};

/** Bangumi（番剧元数据）：搜索候选 → 详情补全 → 封面落内容仓 */
export const bangumiApi = {
	search: (keyword: string) =>
		api.get<{ candidates: BangumiCandidate[] }>(`/api/bangumi/search?keyword=${encodeURIComponent(keyword)}`),
	subject: (id: number) => api.get<BangumiDetail>(`/api/bangumi/subject?id=${id}`),
	/** currentPath 命中托管目录时原位替换旧封面 */
	coverImport: (input: { url: string; title: string; currentPath?: string }) =>
		api.post<SiteMediaResult>("/api/bangumi/cover-import", input),
};

/** 平台导入：简书官方导出包 → 会话清单 → 预览 / 后台导入任务轮询 */
export const importApi = {
	/** 上传 rar/zip 导出包，解析出按文集分组的文章清单 */
	uploadArchive: (file: File) => {
		const form = new FormData();
		form.append("file", file);
		return api.upload<JianshuArchiveSummary>("/api/import/jianshu/archive", form);
	},
	/** 单篇转换预览（不落盘，图片保持远程链接） */
	preview: (sessionId: string, id: string) =>
		api.get<JianshuPreview>(
			`/api/import/jianshu/preview?sessionId=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(id)}`,
		),
	/** 启动后台导入任务，返回 jobId 供轮询 */
	run: (input: { sessionId: string; ids: string[]; options: JianshuImportOptions }) =>
		api.post<{ jobId: string }>("/api/import/jianshu/run", input),
	job: (id: string) => api.get<JianshuImportJob>(`/api/import/jianshu/job?id=${encodeURIComponent(id)}`),
	/** 丢弃导入包（清服务端会话） */
	deleteSession: (id: string) =>
		api.del<{ ok: boolean }>(`/api/import/jianshu/session?id=${encodeURIComponent(id)}`),
	/** 单篇粘贴：转换预览（不落盘）；无会话，预览与导入均携带原始粘贴内容 */
	pastePreview: (input: { html?: string; text?: string }) =>
		api.post<JianshuPreview>("/api/import/jianshu/paste-preview", input),
	/** 单篇粘贴：转换落仓，图片自动下载到文章目录；markdown 为编辑器定稿（优先于 html/text） */
	pasteRun: (input: { html?: string; text?: string; markdown?: string; options: JianshuPasteOptions }) =>
		api.post<JianshuPasteResult>("/api/import/jianshu/paste-run", input),
	/** AI 分析正文补充摘要/分类/标签（AI 未启用/失败回退正文摘要，aiUsed=false） */
	suggestMeta: (input: { title: string; markdown: string }) =>
		api.post<JianshuMetaSuggestion>("/api/import/jianshu/suggest-meta", input),
};

export type { GitStatus };
