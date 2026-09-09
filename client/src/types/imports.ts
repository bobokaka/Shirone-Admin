/** 导入弹窗 → 数据编辑页的回填载荷（纯类型，跨组件共享） */

/** 番剧搜索导入：Bangumi 检索 → 人工确认后填入新建草稿 */
export interface AnimeImportPayload {
	title: string;
	year: string;
	genres: string[];
	description: string;
	/** 已落内容仓的本地封面 src（下载失败时缺省，编辑弹窗可手动补） */
	cover?: string;
	studio?: string;
	link?: string;
	period?: { start: string; end?: string };
	/** 总集数（回填进度 total，watched 留给用户） */
	eps: number;
}

/** 音乐导入（直链/上传/AI 检索）：音频与封面均已落内容仓后回填 */
export interface MusicImportPayload {
	title: string;
	artist?: string;
	/** 已落 assets/images/music/ 的封面 src（可选） */
	cover?: string;
	/** 已落 /assets/music/url/ 的音频 src */
	source: string;
	/** 时长（秒）；探测失败缺省，由用户在编辑弹窗手填 */
	duration?: number;
}

/** 时间线 AI 起草（与服务端 timelineDraft zod 输出对齐的宽松版） */
export interface TimelineDraftPayload {
	title: string;
	/** YYYY-MM-DD 日精度；AI 推断不出为空串，草稿卡片编辑补全 */
	date: string;
	/** milestone | project | career | life */
	category: string;
	subtitle?: string;
	description?: string;
	highlights: string[];
	tags: string[];
}

