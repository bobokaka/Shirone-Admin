<script setup lang="ts">
	import { computed, nextTick, ref, watch } from "vue";
	import { useAiConsoleStore } from "../stores/aiConsole";

	const ai = useAiConsoleStore();
	const listEl = ref<HTMLElement>();

	const elapsedText = computed(() => {
		const s = Math.floor(ai.elapsedMs / 1000);
		return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
	});

	function secondsText(ms?: number): string {
		if (!ms) return "";
		const s = Math.max(1, Math.round(ms / 1000));
		return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
	}

	/** 新内容/新消息到达即滚到底（流式期间跟随输出） */
	watch(
		() => `${ai.entries.length}:${ai.entries.map((e) => e.content.length + (e.thinking?.length ?? 0)).join(",")}`,
		() => {
			void nextTick(() => {
				if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
			});
		},
	);

	function onEnterKey(e: KeyboardEvent): void {
		// 中文输入法组词确认的 Enter 不触发发送
		if (e.isComposing || e.shiftKey) return;
		e.preventDefault();
		void doSend();
	}

	async function doSend(): Promise<void> {
		if (ai.running || ai.draft.trim() === "") return;
		await ai.send(ai.draft);
	}
</script>

<template>
	<div v-if="ai.visible" class="ai-console" :class="{ 'is-running': ai.running, 'is-collapsed': ai.collapsed }">
		<header class="ai-console-head" title="点击展开 / 收起" @click="ai.toggleCollapsed()">
			<span class="head-icon">✨</span>
			<span class="head-title">AI 助手</span>
			<span class="head-status">{{ ai.statusLabel }}<template v-if="ai.running"> · {{ elapsedText }}</template></span>
			<button v-if="!ai.running && ai.entries.length" class="head-btn" @click.stop="ai.newTalk()">新对话</button>
			<button v-if="ai.running" class="head-btn danger" @click.stop="ai.stop()">停止</button>
			<button class="head-btn" @click.stop="ai.close()">关闭</button>
		</header>

		<template v-if="!ai.collapsed">
			<div ref="listEl" class="msg-list">
				<div v-if="ai.entries.length === 0" class="msg-empty">
					任务结束后可在这里继续追问（携带上文），也可以直接输入问题与 AI 对话。
				</div>
				<div v-for="e in ai.entries" :key="e.id" class="msg" :class="e.role">
					<!-- 用户：任务条目带「任务」角标，聊天条目为原文气泡 -->
					<template v-if="e.role === 'user'">
						<span v-if="e.send" class="task-chip">任务</span>
						<span class="msg-text">{{ e.content }}</span>
					</template>
					<template v-else>
						<div v-if="e.thinking" class="think-block">
							<button class="think-toggle" @click="ai.toggleEntryThinking(e.id)">
								{{ e.thinkingOpen ? "▾" : "▸" }} 思考过程
							</button>
							<pre v-show="e.thinkingOpen" class="think-body">{{ e.thinking }}</pre>
						</div>
						<div class="msg-text assistant-text" :class="{ 'is-streaming': ai.running && e === ai.entries[ai.entries.length - 1] }">
							<template v-if="e.content !== ''">{{ e.content }}</template>
							<span v-else-if="ai.running && e === ai.entries[ai.entries.length - 1]" class="pending-line">
								正在等待模型输出…
							</span>
							<span v-else-if="e.error" class="error-line">{{ e.error }}</span>
							<span v-else class="pending-line">已停止</span>
						</div>
						<div v-if="e.elapsedMs" class="msg-meta">
							<template v-if="e.stopped">已停止 · </template>
							<template v-if="e.error">失败 · </template>
							{{ secondsText(e.elapsedMs) }}<template v-if="e.model"> · {{ e.model }}</template>
						</div>
					</template>
				</div>
			</div>

			<footer class="chat-input">
				<el-input
					v-model="ai.draft"
					type="textarea"
					:rows="2"
					resize="none"
					placeholder="继续追问或直接对话…（Enter 发送，Shift+Enter 换行）"
					@keydown.enter="onEnterKey"
				/>
				<el-button
					type="primary"
					class="send-btn"
					:disabled="ai.running || ai.draft.trim() === ''"
					@click="doSend"
				>
					发送
				</el-button>
			</footer>
		</template>
	</div>
</template>

<style scoped>
.ai-console {
	position: fixed;
	right: 20px;
	bottom: 20px;
	z-index: 3000; /* 高于 el-dialog（~2000），弹窗内触发的 AI 也要看得见 */
	width: min(520px, calc(100vw - 40px));
	max-height: min(70vh, 560px);
	display: flex;
	flex-direction: column;
	background: var(--el-bg-color);
	border: 1px solid var(--el-border-color-light);
	border-radius: 10px;
	box-shadow: var(--el-box-shadow-light);
	overflow: hidden;
}
/* 收起成标题条：只占一小条，点标题展开回看 */
.ai-console.is-collapsed {
	width: auto;
	max-height: none;
}
.ai-console.is-running {
	border-color: var(--el-color-primary-light-5);
	animation: ai-console-pulse 2.4s ease-in-out infinite;
}
@keyframes ai-console-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 2px rgb(64 158 255 / 12%);
	}
	50% {
		box-shadow: 0 0 0 5px rgb(64 158 255 / 26%);
	}
}

.ai-console-head {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 10px 12px;
	border-bottom: 1px solid var(--el-border-color-lighter);
	background: var(--el-fill-color-light);
	cursor: pointer;
	flex: none;
}
.head-icon {
	font-size: 15px;
}
.head-title {
	font-weight: 600;
	font-size: 20px;
	white-space: nowrap;
}
.head-status {
	flex: 1;
	font-size: 16px;
	color: var(--el-text-color-secondary);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.head-btn {
	border: 1px solid var(--el-border-color);
	background: var(--el-bg-color);
	color: var(--el-text-color-regular);
	border-radius: 6px;
	padding: 3px 12px;
	font-size: 12px;
	cursor: pointer;
	flex: none;
}
.head-btn:hover {
	color: var(--el-color-primary);
	border-color: var(--el-color-primary-light-5);
}
.head-btn.danger {
	color: #fff;
	background: var(--el-color-danger);
	border-color: var(--el-color-danger);
}
.head-btn.danger:hover {
	background: var(--el-color-danger-light-3);
}

.msg-list {
	flex: 1;
	min-height: 120px;
	overflow-y: auto;
	padding: 12px;
	display: flex;
	flex-direction: column;
	gap: 12px;
}
.msg-empty {
	font-size: 20px;
	color: var(--el-text-color-placeholder);
	line-height: 1.8;
	padding: 8px 4px;
}
.msg {
	max-width: 92%;
	display: flex;
	flex-direction: column;
	gap: 4px;
	font-size: 20px;
	line-height: 1.7;
}
/* 用户消息：右侧缩进气泡（任务条目 = 任务名 + 角标） */
.msg.user {
	align-self: flex-end;
	align-items: flex-end;
	background: var(--el-color-primary-light-9, #ecf5ff);
	border: 1px solid var(--el-color-primary-light-7, #d9ecff);
	border-radius: 10px 10px 2px 10px;
	padding: 6px 10px;
	white-space: pre-wrap;
	word-break: break-word;
}
.task-chip {
	font-size: 10px;
	line-height: 1;
	padding: 2px 5px;
	margin-right: 6px;
	border-radius: 4px;
	color: var(--el-color-primary);
	background: var(--el-color-primary-light-8, #d9ecff);
	flex: none;
	align-self: center;
}
/* AI 消息：左侧，无气泡底色，靠缩进区分 */
.msg.assistant {
	align-self: flex-start;
	width: 100%;
	max-width: 100%;
}
.think-block {
	border-left: 2px solid var(--el-border-color-lighter);
	padding-left: 8px;
	margin-bottom: 2px;
}
.think-toggle {
	border: none;
	background: none;
	color: var(--el-text-color-secondary);
	font-size: 12px;
	padding: 0;
	cursor: pointer;
}
.think-toggle:hover {
	color: var(--el-text-color-primary);
}
.think-body {
	margin: 4px 0 0;
	max-height: 160px;
	overflow: auto;
	font-family: ui-monospace, Consolas, "Courier New", monospace;
	font-size: 20px;
	line-height: 1.7;
	color: var(--el-text-color-secondary);
	white-space: pre-wrap;
	word-break: break-word;
}
.assistant-text {
	white-space: pre-wrap;
	word-break: break-word;
}
/* 流式中的最后一条：尾部光标呼吸 */
.assistant-text.is-streaming::after {
	content: "▍";
	color: var(--el-color-primary);
	animation: cursor-blink 1s step-end infinite;
	margin-left: 1px;
}
@keyframes cursor-blink {
	50% {
		opacity: 0;
	}
}
.msg-meta {
	font-size: 16px;
	color: var(--el-text-color-placeholder);
}
.pending-line {
	color: var(--el-text-color-placeholder);
	font-size: 20px;
}
.error-line {
	color: var(--el-color-danger);
	font-size: 20px;
}

.chat-input {
	flex: none;
	display: flex;
	gap: 8px;
	align-items: flex-end;
	padding: 10px 12px;
	border-top: 1px solid var(--el-border-color-lighter);
	background: var(--el-fill-color-lighter, var(--el-fill-color-light));
}
.chat-input .el-input {
	flex: 1;
}
.send-btn {
	flex: none;
}
</style>
