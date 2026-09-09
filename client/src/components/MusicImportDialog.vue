<script setup lang="ts">
	import { ref } from "vue";
	import { ElMessage } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { MusicSearchCandidate, SiteMediaResult } from "@shirone-admin/shared";
	import { aiApi, musicApi } from "../api";
	import { probeAudioDuration } from "../utils/audioProbe";
	import type { MusicImportPayload } from "../types/imports";

	/**
	 * 音乐导入三模式：直接链接（server 代取直链）/ 本地上传 / AI 联网检索（版权判定 + 依据链接）。
	 * 音频落 public/assets/music/url/、封面落 assets/images/music/，时长客户端探测（失败回退手填），
	 * 完成后 emit 载荷由 DataView 填入新建草稿（曲目 id 由编辑弹窗 autoKey 生成）。
	 */
	const visible = defineModel<boolean>({ default: false });
	const emit = defineEmits<{ apply: [payload: MusicImportPayload] }>();

	type ImportMode = "link" | "upload" | "ai";
	const mode = ref<ImportMode>("link");

	/* ---------- 直接链接模式 ---------- */

	const audioUrl = ref("");
	const coverUrl = ref("");
	const title = ref("");
	const artist = ref("");
	const linkBusy = ref(false);

	/** 可选封面导入：空地址返回 undefined；失败仅警告不阻断导入 */
	async function importCover(url: string, name: string): Promise<string | undefined> {
		if (url === "") return undefined;
		if (!/^https?:\/\//i.test(url)) {
			ElMessage.warning("封面地址需以 http(s):// 开头，已跳过");
			return undefined;
		}
		try {
			const r = await musicApi.coverImport({ kind: "music", url, title: name });
			return r.src;
		} catch (e) {
			ElMessage.warning(`封面导入失败：${(e as Error).message}`);
			return undefined;
		}
	}

	async function importFromLink(): Promise<void> {
		const url = audioUrl.value.trim();
		const name = title.value.trim();
		if (url === "") {
			ElMessage.warning("请填音频直链地址");
			return;
		}
		if (!/^https?:\/\//i.test(url)) {
			ElMessage.warning("音频地址需以 http(s):// 开头");
			return;
		}
		if (name === "") {
			ElMessage.warning("请填曲名");
			return;
		}
		if (linkBusy.value) return;
		linkBusy.value = true;
		try {
			const r = await musicApi.downloadAudio({ url, filename: name });
			const cover = await importCover(coverUrl.value.trim(), name);
			await finish({ title: name, artist: artist.value.trim(), cover, source: r });
		} catch (e) {
			ElMessage.error(`导入失败：${(e as Error).message}`);
		} finally {
			linkBusy.value = false;
		}
	}

	/* ---------- 本地上传模式 ---------- */

	const uploadTitle = ref("");
	const uploadArtist = ref("");
	const uploadResult = ref<SiteMediaResult | null>(null);
	const uploading = ref(false);

	async function uploadLocal(file: File): Promise<void> {
		if (uploading.value) return;
		uploading.value = true;
		try {
			const r = await musicApi.uploadAudio(file);
			uploadResult.value = r;
			if (uploadTitle.value.trim() === "") {
				uploadTitle.value = r.fileName.replace(/\.[^.]*$/, "");
			}
			ElMessage.success(`已上传 ${r.fileName}，确认后填入新建曲目`);
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			uploading.value = false;
		}
	}

	/** el-upload 的 http-request 适配（模板表达式里写不了带类型的箭头函数） */
	function uploadRequest(options: { file: File }): Promise<void> {
		return uploadLocal(options.file);
	}

	async function importFromUpload(): Promise<void> {
		if (!uploadResult.value) {
			ElMessage.warning("请先上传音频文件");
			return;
		}
		const name = uploadTitle.value.trim();
		if (name === "") {
			ElMessage.warning("请填曲名");
			return;
		}
		await finish({
			title: name,
			artist: uploadArtist.value.trim(),
			source: uploadResult.value,
		});
	}

	/* ---------- AI 检索模式（版权感知）---------- */

	const aiQuery = ref("");
	const aiSearching = ref(false);
	const aiSearched = ref(false);
	const aiCandidates = ref<MusicSearchCandidate[]>([]);
	/** false = 服务不支持联网检索已降级，结果可信度低 */
	const searchUsed = ref(true);
	const importingIndex = ref(-1);

	async function doAiSearch(): Promise<void> {
		const q = aiQuery.value.trim();
		if (q === "") {
			ElMessage.warning("请输入曲名或关键词");
			return;
		}
		if (aiSearching.value) return;
		aiSearching.value = true;
		try {
			const r = await aiApi.musicSearch(q);
			aiCandidates.value = r.candidates;
			searchUsed.value = r.searchUsed;
			aiSearched.value = true;
			if (r.candidates.length === 0) ElMessage.info("未检索到候选，可改用直接链接模式");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			aiSearching.value = false;
		}
	}

	async function importCandidate(c: MusicSearchCandidate, index: number): Promise<void> {
		if (!c.audioUrl || importingIndex.value >= 0) return;
		importingIndex.value = index;
		try {
			const r = await musicApi.downloadAudio({
				url: c.audioUrl,
				filename: c.artist ? `${c.title} ${c.artist}` : c.title,
			});
			const cover = await importCover(c.coverUrl ?? "", c.title);
			await finish({ title: c.title, artist: c.artist, cover, source: r });
		} catch (e) {
			ElMessage.error(`导入失败：${(e as Error).message}`);
		} finally {
			importingIndex.value = -1;
		}
	}

	/** 无直链候选：把元数据带回直接链接模式，引导去来源页复制直链 */
	function carryToLink(c: MusicSearchCandidate): void {
		mode.value = "link";
		title.value = c.title;
		artist.value = c.artist ?? "";
		coverUrl.value = c.coverUrl ?? "";
		audioUrl.value = "";
		ElMessage.info("已带出元数据，请到来源页复制音频直链后填入");
	}

	/* ---------- 收尾：探时长 → emit → 关闭 ---------- */

	async function finish(p: {
		title: string;
		artist?: string;
		cover?: string;
		source: SiteMediaResult;
	}): Promise<void> {
		const duration = await probeAudioDuration(p.source.previewUrl);
		if (duration === undefined) ElMessage.warning("时长探测失败，请在编辑弹窗手动填写");
		const payload: MusicImportPayload = {
			title: p.title,
			source: p.source.src,
			...(p.artist ? { artist: p.artist } : {}),
			...(p.cover ? { cover: p.cover } : {}),
			...(duration !== undefined ? { duration } : {}),
		};
		emit("apply", payload);
		visible.value = false;
	}
</script>

<template>
	<el-dialog v-model="visible" title="导入音乐" width="760px" top="6vh" class="music-import-dialog">
		<el-radio-group v-model="mode" class="mode-switch">
			<el-radio-button value="link">直接链接</el-radio-button>
			<el-radio-button value="upload">本地上传</el-radio-button>
			<el-radio-button value="ai">AI搜索</el-radio-button>
		</el-radio-group>

		<!-- 直接链接 -->
		<div v-if="mode === 'link'" class="mode-panel">
			<el-form label-width="92px">
				<el-form-item label="音频直链" required>
					<el-input v-model="audioUrl" placeholder="https://…/track.mp3（需是文件直链，不是网页地址）" clearable />
				</el-form-item>
				<el-form-item label="曲名" required>
					<el-input v-model="title" placeholder="曲名" />
				</el-form-item>
				<el-form-item label="艺术家">
					<el-input v-model="artist" />
				</el-form-item>
				<el-form-item label="封面直链">
					<el-input v-model="coverUrl" placeholder="https://…/cover.jpg（可选，一并落仓）" clearable />
				</el-form-item>
			</el-form>
			<div class="panel-actions">
				<el-button type="primary" :loading="linkBusy" @click="importFromLink">下载并填入</el-button>
			</div>
		</div>

		<!-- 本地上传 -->
		<div v-else-if="mode === 'upload'" class="mode-panel">
			<el-upload
				drag
				accept=".mp3,.ogg,.oga,.opus,.wav,.flac,.m4a,.aac"
				:show-file-list="false"
				:http-request="uploadRequest"
				class="audio-upload"
			>
				<el-icon class="el-icon--upload"><UploadFilled /></el-icon>
				<div class="el-upload__text">拖入音频文件，或<em>点击选择</em></div>
				<template #tip>
					<div class="muted upload-tip">mp3 / ogg / wav / flac / m4a / aac，不超过 28MB</div>
				</template>
			</el-upload>
			<el-tag v-if="uploadResult" type="success" size="small" disable-transitions class="uploaded-tag">
				已上传 {{ uploadResult.fileName }}
			</el-tag>
			<el-form label-width="92px">
				<el-form-item label="曲名" required>
					<el-input v-model="uploadTitle" placeholder="曲名" />
				</el-form-item>
				<el-form-item label="艺术家">
					<el-input v-model="uploadArtist" />
				</el-form-item>
			</el-form>
			<div class="panel-actions">
				<el-button type="primary" :disabled="!uploadResult" @click="importFromUpload">填入新建曲目</el-button>
			</div>
		</div>

		<!-- AI 检索 -->
		<div v-else class="mode-panel">
			<div class="search-bar">
				<el-input
					v-model="aiQuery"
					placeholder="曲名 / 关键词，如 低调钢琴曲 CC0"
					clearable
					@keydown.enter.prevent="doAiSearch"
				/>
				<el-button type="primary" :loading="aiSearching" @click="doAiSearch">
					<el-icon v-if="!aiSearching"><Icon icon="material-symbols:auto-awesome" /></el-icon>AI检索
				</el-button>
			</div>
			<el-alert
				v-if="aiSearched && !searchUsed"
				type="warning"
				:closable="false"
				show-icon
				class="degrade-tip"
			>
				当前 AI 服务不支持联网检索，以下结果来自模型记忆，版权状态请务必自行核实。
			</el-alert>
			<div v-loading="aiSearching" class="candidate-area">
				<template v-if="aiCandidates.length">
					<div v-for="(c, i) in aiCandidates" :key="i" class="music-candidate">
						<div class="mc-head">
							<span class="mc-title">{{ c.title }}</span>
							<span v-if="c.artist" class="mc-artist">{{ c.artist }}</span>
							<el-tag
								:type="c.license.freeCommercial ? 'success' : 'warning'"
								size="small"
								disable-transitions
							>
								{{ c.license.freeCommercial ? "可免费商用" : "需授权确认" }}
							</el-tag>
						</div>
						<div class="mc-summary">{{ c.license.summary }}</div>
						<div class="mc-links">
							<el-link v-if="c.license.evidence" :href="c.license.evidence" target="_blank" type="primary">
								授权依据
							</el-link>
							<el-link v-if="c.license.sourceUrl" :href="c.license.sourceUrl" target="_blank" type="primary">
								来源页
							</el-link>
							<el-link v-if="c.audioUrl" :href="c.audioUrl" target="_blank" type="info">试听直链</el-link>
							<span v-else class="mc-no-audio">无直链，需去来源页获取</span>
						</div>
						<div class="mc-ops">
							<el-button
								v-if="c.audioUrl"
								size="small"
								type="primary"
								:loading="importingIndex === i"
								@click="importCandidate(c, i)"
							>
								下载导入
							</el-button>
							<el-button size="small" @click="carryToLink(c)">去来源页取直链</el-button>
						</div>
					</div>
				</template>
				<el-empty v-else-if="aiSearched" description="未检索到候选，试试更具体的关键词或改用直接链接" :image-size="72" />
				<el-empty v-else description="输入曲名，AI 联网检索可免费商用的版本与授权依据" :image-size="72" />
			</div>
		</div>
	</el-dialog>
</template>

<style scoped>
	.mode-switch {
		margin-bottom: 16px;
	}
	.mode-panel {
		min-height: 240px;
		display: flex;
		flex-direction: column;
	}
	.panel-actions {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		margin-top: 6px;
	}
	.search-bar {
		display: flex;
		gap: 10px;
		margin-bottom: 12px;
	}
	.degrade-tip {
		margin-bottom: 12px;
	}
	.audio-upload {
		align-self: flex-start;
		width: 100%;
		margin-bottom: 12px;
	}
	.upload-tip {
		font-size: 20px;
		margin-top: 6px;
	}
	.uploaded-tag {
		align-self: flex-start;
		margin-bottom: 12px;
	}
	.candidate-area {
		min-height: 220px;
		max-height: 52vh;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
	.music-candidate {
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 12px 14px;
		border: 1px solid var(--hairline);
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.45);
	}
	.mc-head {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
	.mc-title {
		font-weight: 600;
		font-size: 20px;
	}
	.mc-artist {
		font-size: 20px;
		color: var(--text-sub);
	}
	.mc-summary {
		font-size: 20px;
		line-height: 1.6;
	}
	.mc-links {
		display: flex;
		align-items: center;
		gap: 14px;
		flex-wrap: wrap;
		font-size: 20px;
	}
	.mc-no-audio {
		color: var(--text-sub);
	}
	.mc-ops {
		display: flex;
		gap: 8px;
	}
</style>
