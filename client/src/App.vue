<script setup lang="ts">
	import { computed, onMounted, ref } from "vue";
	import { useRoute } from "vue-router";
	import { ElMessage } from "element-plus";
	import { useSystemStore } from "./stores/system";
	import { useAiConsoleStore } from "./stores/aiConsole";
	import AppSettingsDialog from "./components/AppSettingsDialog.vue";
	import AiConsole from "./components/AiConsole.vue";

	const route = useRoute();
	const sys = useSystemStore();
	const ai = useAiConsoleStore();
	const settingsOpen = ref(false);

	const title = computed(() => (route.meta.title as string) ?? "");

	onMounted(() => {
		sys.refresh().catch((e: Error) => ElMessage.error(e.message));
	});
</script>

<template>
	<el-container class="shell">
		<el-aside width="212px" class="aside">
			<div class="brand">
				<span class="logo"></span>
				<span>Shirone&nbsp;<em>Admin</em></span>
			</div>
			<el-menu router :default-active="route.path" class="menu">
				<el-menu-item index="/dashboard">
					<el-icon><Odometer /></el-icon>仪表盘
				</el-menu-item>
				<el-menu-item index="/posts">
					<el-icon><Document /></el-icon>文章管理
				</el-menu-item>
				<el-menu-item index="/moments">
					<el-icon><ChatDotRound /></el-icon>说说动态
				</el-menu-item>
				<el-menu-item index="/data">
					<el-icon><Grid /></el-icon>数据管理
				</el-menu-item>
				<el-menu-item index="/settings">
					<el-icon><Setting /></el-icon>站点设置
				</el-menu-item>
				<el-menu-item index="/import">
					<el-icon><Download /></el-icon>平台导入
				</el-menu-item>
				<el-menu-item index="/publish">
					<el-icon><Promotion /></el-icon>提交和发布
				</el-menu-item>
			</el-menu>
		</el-aside>
		<el-container>
			<el-header class="header">
				<span class="title">{{ title }}</span>
				<span class="conn">
					<el-tag size="small" :type="sys.status?.contentConnected ? 'success' : 'danger'">
						{{ sys.status?.contentConnected ? "已连接" : "未连接" }}
					</el-tag>
					<el-tooltip content="AI 控制台" placement="bottom">
						<el-button class="gear-btn" text circle @click="ai.toggle()">✨</el-button>
					</el-tooltip>
					<el-tooltip content="设置" placement="bottom">
						<el-button class="gear-btn" text circle @click="settingsOpen = true">
							<el-icon :size="18"><Setting /></el-icon>
						</el-button>
					</el-tooltip>
				</span>
			</el-header>
			<el-main>
				<router-view />
			</el-main>
		</el-container>
	</el-container>
	<AppSettingsDialog v-model="settingsOpen" />
	<AiConsole />
</template>
