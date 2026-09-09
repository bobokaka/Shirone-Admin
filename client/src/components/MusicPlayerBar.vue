<script setup lang="ts">
	import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
	import { ElMessage } from "element-plus";
	import type { DataItem } from "@shirone-admin/shared";
	import { contentPreviewUrl } from "../utils/assets";
	import { formatDuration } from "../utils/format";

	/* 数据页歌单试听条：曲目选择状态由父级持有（track 双向），
	   音频元素常驻本组件，切歌/暂停不打断，跨数据类型页签持续播放。 */

	const props = defineProps<{
		/** 歌单列表，顺序即连播顺序 */
		items: DataItem[];
		/** 当前曲目；null 收起播放条 */
		track: DataItem | null;
	}>();

	const emit = defineEmits<{
		"update:track": [value: DataItem | null];
		"update:playing": [value: boolean];
	}>();

	const audioRef = ref<HTMLAudioElement>();
	const playing = ref(false);
	const currentTime = ref(0);
	/** 元数据加载前的兜底时长（取条目 duration 字段），加载后为音频实测值 */
	const duration = ref(0);
	const dragging = ref(false);
	const dragTime = ref(0);
	const volume = ref(0.8);
	const lastVolume = ref(0.8);

	const coverUrl = computed(() => contentPreviewUrl(props.track?.cover));
	const title = computed(() => String(props.track?.title ?? "未命名曲目"));
	const artist = computed(() => String(props.track?.artist ?? "").trim());
	const currentIndex = computed(() =>
		props.items.findIndex((x) => props.track && sameTrack(x, props.track)),
	);
	const sliderValue = computed(() => (dragging.value ? dragTime.value : currentTime.value));

	/** 同一曲判定：优先曲目 id（编辑/重读后对象会换引用），退回引用相等 */
	function sameTrack(a: DataItem, b: DataItem): boolean {
		if (a === b) return true;
		const x = String(a.id ?? "");
		return x !== "" && x === String(b.id ?? "");
	}

	function loadTrack(t: DataItem | null): void {
		const a = audioRef.value;
		if (!a) return;
		playing.value = false;
		emit("update:playing", false);
		currentTime.value = 0;
		dragTime.value = 0;
		duration.value = Number(t?.duration) || 0;
		if (!t) {
			a.pause();
			a.removeAttribute("src");
			a.load();
			return;
		}
		const url = contentPreviewUrl(t.source);
		if (!url) {
			ElMessage.warning(`「${String(t.title ?? "")}」没有音频地址`);
			emit("update:track", null);
			return;
		}
		a.src = url;
		void a.play().catch(() => {});
	}

	/** 播放/暂停当前曲目（播放列与播放条主按钮共用） */
	function togglePlay(): void {
		const a = audioRef.value;
		if (!a || !props.track) return;
		if (a.paused) void a.play().catch(() => {});
		else a.pause();
	}

	function skipTo(delta: number): void {
		const j = currentIndex.value + delta;
		if (j < 0 || j >= props.items.length) return;
		emit("update:track", props.items[j]);
	}

	function prev(): void {
		// 播放超过 3 秒先回到本曲开头，否则切上一首
		const a = audioRef.value;
		if (a && a.currentTime > 3) {
			a.currentTime = 0;
			return;
		}
		skipTo(-1);
	}

	function onSliderInput(v: number | number[]): void {
		dragging.value = true;
		dragTime.value = v as number;
	}

	function onSliderChange(v: number | number[]): void {
		dragging.value = false;
		const t = v as number;
		currentTime.value = t;
		if (audioRef.value) audioRef.value.currentTime = t;
	}

	function applyVolume(): void {
		if (audioRef.value) audioRef.value.volume = volume.value;
	}

	function toggleMute(): void {
		if (volume.value > 0) {
			lastVolume.value = volume.value;
			volume.value = 0;
		} else {
			volume.value = lastVolume.value || 0.8;
		}
	}

	function onPlay(): void {
		playing.value = true;
		emit("update:playing", true);
	}

	function onPause(): void {
		playing.value = false;
		emit("update:playing", false);
	}

	function onTimeUpdate(e: Event): void {
		if (dragging.value) return;
		currentTime.value = (e.target as HTMLAudioElement).currentTime;
	}

	function onLoadedMetadata(e: Event): void {
		const d = (e.target as HTMLAudioElement).duration;
		if (Number.isFinite(d) && d > 0) duration.value = d;
	}

	function onEnded(): void {
		onPause();
		skipTo(1); // 列表末尾自然停止
	}

	function onError(): void {
		if (!audioRef.value?.src) return;
		onPause();
		ElMessage.error(`音频加载失败：${title.value}`);
	}

	watch(
		() => props.track,
		(t, old) => {
			// 同一曲仅换对象（编辑/重读条目后）：不重启播放
			if (t && old && sameTrack(t, old)) return;
			loadTrack(t);
		},
	);

	// 列表变动（编辑/删除/重读）后对齐当前曲目引用；曲目被删则收起
	watch(
		() => props.items,
		(list) => {
			const t = props.track;
			if (!t) return;
			const fresh = list.find((x) => sameTrack(x, t));
			if (!fresh) {
				loadTrack(null);
				emit("update:track", null);
				return;
			}
			if (fresh !== t) emit("update:track", fresh);
		},
		{ deep: true },
	);

	// 音量变化统一经 watch 落到音频元素，避开 el-slider input/update 双事件的顺序问题
	watch(volume, applyVolume);

	onMounted(applyVolume);

	onBeforeUnmount(() => {
		const a = audioRef.value;
		if (!a) return;
		a.pause();
		a.removeAttribute("src");
		a.load();
	});

	defineExpose({ togglePlay });
</script>

<template>
	<div class="music-player">
		<audio
			ref="audioRef"
			preload="metadata"
			@play="onPlay"
			@pause="onPause"
			@timeupdate="onTimeUpdate"
			@loadedmetadata="onLoadedMetadata"
			@ended="onEnded"
			@error="onError"
		/>
		<Transition name="player-slide">
			<div v-if="track" class="player-bar">
				<el-image
					v-if="coverUrl"
					class="bar-cover"
					:src="coverUrl"
					:preview-src-list="[coverUrl]"
					fit="cover"
					preview-teleported
				/>
				<div v-else class="bar-cover bar-cover--empty"><el-icon><Headset /></el-icon></div>
				<div class="bar-meta">
					<div class="bar-title" :title="title">{{ title }}</div>
					<div class="bar-artist" :title="artist">{{ artist || "—" }}</div>
				</div>
				<div class="bar-controls">
					<el-button size="small" text title="上一首（播放中点击回到开头）" @click="prev">
						<el-icon><DArrowLeft /></el-icon>
					</el-button>
					<el-button circle type="primary" class="bar-play" :title="playing ? '暂停' : '播放'" @click="togglePlay">
						<el-icon :size="16">
							<VideoPause v-if="playing" />
							<VideoPlay v-else />
						</el-icon>
					</el-button>
					<el-button
						size="small"
						text
						title="下一首"
						:disabled="currentIndex < 0 || currentIndex >= items.length - 1"
						@click="skipTo(1)"
					>
						<el-icon><DArrowRight /></el-icon>
					</el-button>
				</div>
				<span class="bar-time">{{ formatDuration(sliderValue) }}</span>
				<el-slider
					class="bar-slider"
					:model-value="sliderValue"
					:min="0"
					:max="duration || 1"
					:step="1"
					:disabled="!duration"
					:format-tooltip="formatDuration"
					@input="onSliderInput"
					@change="onSliderChange"
				/>
				<span class="bar-time">{{ duration ? formatDuration(duration) : "--:--" }}</span>
				<div class="bar-volume">
					<el-button size="small" text :title="volume === 0 ? '取消静音' : '静音'" @click="toggleMute">
						<el-icon><Mute v-if="volume === 0" /><Headset v-else /></el-icon>
					</el-button>
					<el-slider
						v-model="volume"
						class="bar-volume-slider"
						:min="0"
						:max="1"
						:step="0.05"
						:show-tooltip="false"
					/>
				</div>
				<el-button size="small" text class="bar-close" title="关闭播放条" @click="emit('update:track', null)">
					<el-icon><Close /></el-icon>
				</el-button>
			</div>
		</Transition>
	</div>
</template>

<style scoped>
	.music-player {
		flex: none;
	}
	.player-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
		row-gap: 6px;
		margin-top: 10px;
		padding: 8px 16px;
		border: 1px solid var(--glass-border-soft);
		border-radius: 14px;
		background: var(--glass-bg);
		box-shadow: var(--glass-shadow);
	}
	.bar-cover,
	.bar-cover--empty {
		flex: none;
		width: 42px;
		height: 42px;
		border-radius: 10px;
		overflow: hidden;
	}
	.bar-cover--empty {
		display: flex;
		align-items: center;
		justify-content: center;
		background: rgba(128, 128, 150, 0.14);
		color: var(--text-sub, #909399);
	}
	.bar-meta {
		flex: none;
		width: 148px;
		min-width: 0;
	}
	.bar-title {
		font-size: 20px;
		font-weight: 600;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.bar-artist {
		font-size: 20px;
		color: var(--text-sub, #5d5d78);
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.bar-controls {
		flex: none;
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.bar-play {
		margin: 0 4px;
	}
	.bar-time {
		flex: none;
		font-size: 16px;
		font-variant-numeric: tabular-nums;
		color: var(--text-sub, #5d5d78);
		white-space: nowrap;
	}
	.bar-slider {
		flex: 1;
		min-width: 120px;
	}
	.bar-slider :deep(.el-slider__runway) {
		margin: 0;
		height: 6px;
	}
	.bar-volume {
		flex: none;
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.bar-volume-slider {
		width: 64px;
	}
	.bar-volume-slider :deep(.el-slider__runway) {
		margin: 0;
		height: 4px;
	}
	.player-slide-enter-active,
	.player-slide-leave-active {
		transition:
			opacity 0.25s ease,
			transform 0.25s ease;
	}
	.player-slide-enter-from,
	.player-slide-leave-to {
		opacity: 0;
		transform: translateY(10px);
	}
</style>
