<script setup lang="ts">
	import { computed, nextTick, reactive, ref, watch } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import { Icon } from "@iconify/vue";
	import type { AiProviderConfig, AiSettings, AiTestResult, ProjectMappingStatus } from "@shirone-admin/shared";
	import { aiApi, systemApi } from "../api";
	import { useSystemStore } from "../stores/system";
	import { parseAiEnvImport, type AiImportResult } from "../utils/aiImport";
	import DirDetectDialog from "./DirDetectDialog.vue";

	/**
	 * 右上角齿轮打开的全局设置弹窗：左侧菜单 + 右侧内容。
	 * 面板按 section 扩展：AI 助手、项目映射（两仓磁盘目录）、关于。
	 */

	const visible = defineModel<boolean>({ default: false });
	const sys = useSystemStore();

	type Section = "ai" | "mapping" | "about";
	const section = ref<Section>("ai");

	const loading = ref(false);
	const saving = ref(false);
	const testing = ref(false);

	const form = reactive<AiSettings>({
		enable: false,
		providers: [],
		activeId: "",
	});
	const testResult = ref<AiTestResult | null>(null);

	const importText = ref("");
	const importResult = ref<AiImportResult | null>(null);

	/** 名称输入框：新增服务商后聚焦并全选，直接改名即「进入编辑状态」 */
	const nameInput = ref<{ focus: () => void; select: () => void } | null>(null);

	/** 当前编辑（保存后即为生效）的服务商；列表未加载完成时为 null */
	const current = computed<AiProviderConfig | null>(
		() => form.providers.find((p) => p.id === form.activeId) ?? form.providers[0] ?? null,
	);

	watch(visible, (open) => {
		if (!open) return;
		testResult.value = null;
		loadSettings();
		void loadMapping();
	});

	async function loadSettings(): Promise<void> {
		loading.value = true;
		try {
			const remote = await aiApi.getSettings();
			form.providers = remote.providers;
			form.activeId = remote.activeId;
			form.enable = remote.enable;
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loading.value = false;
		}
	}

	const configured = computed(() => {
		const p = current.value;
		return (
			!!p &&
			/^https?:\/\//.test(p.baseUrl.trim()) &&
			p.apiKey.trim() !== "" &&
			p.model.trim() !== ""
		);
	});

	const baseUrlPlaceholder = computed(() =>
		current.value?.protocol === "openai"
			? "https://api.openai.com/v1 或中转代理地址"
			: "https://api.anthropic.com 或 https://open.bigmodel.cn/api/anthropic",
	);

	/** 未占用的新服务商名：默认配置 1、默认配置 2 … */
	function newProviderName(): string {
		const taken = new Set(form.providers.map((p) => p.name));
		for (let i = 1; i <= 99; i++) {
			const name = `默认配置 ${i}`;
			if (!taken.has(name)) return name;
		}
		return "新配置";
	}

	/** 新增：建「默认配置 N」、选中它并聚焦全选名称，输入即改名 */
	async function addProvider(): Promise<void> {
		const provider: AiProviderConfig = {
			id: crypto.randomUUID(),
			name: newProviderName(),
			protocol: "anthropic",
			baseUrl: "",
			apiKey: "",
			model: "",
			modelFast: "",
			webSearch: true,
			temperature: 0.7,
			timeoutSeconds: 30,
		};
		form.providers.push(provider);
		form.activeId = provider.id;
		testResult.value = null;
		await nextTick();
		nameInput.value?.focus();
		nameInput.value?.select();
	}

	/** 行内删除：二次确认；删的是当前项则切到首个，删空则自动补一个空白项 */
	async function removeProvider(provider: AiProviderConfig): Promise<void> {
		try {
			await ElMessageBox.confirm(
				`删除服务商「${provider.name}」？其 API Key 等配置将一并移除。`,
				"删除服务商",
				{ type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
			);
		} catch {
			return; // 取消/关闭属正常操作
		}
		form.providers = form.providers.filter((p) => p.id !== provider.id);
		testResult.value = null;
		if (form.providers.length === 0) {
			await addProvider();
		} else if (form.activeId === provider.id || !form.providers.some((p) => p.id === form.activeId)) {
			form.activeId = form.providers[0].id;
		}
	}

	function runImport(): void {
		const text = importText.value.trim();
		if (text === "") {
			ElMessage.warning("请先粘贴配置内容");
			return;
		}
		const target = current.value;
		if (!target) {
			ElMessage.warning("请先新增一个服务商");
			return;
		}
		const result = parseAiEnvImport(text);
		importResult.value = result;
		if (result.recognized.length === 0) {
			ElMessage.error("未识别到有效配置项：支持 settings.json 的 env 块或 export 语句");
			return;
		}
		Object.assign(target, result.patch);
		testResult.value = null;
		ElMessage.success(`已识别 ${result.recognized.length} 项并填入「${target.name}」，请测试连接后保存`);
	}

	async function save(): Promise<void> {
		if (form.enable && !configured.value) {
			ElMessage.warning("启用前需为当前选中的服务商填写完整的 API 地址、Key 与模型名");
			return;
		}
		saving.value = true;
		try {
			const remote = await aiApi.saveSettings({ ...form });
			form.providers = remote.providers;
			form.activeId = remote.activeId;
			ElMessage.success("AI 设置已保存");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			saving.value = false;
		}
	}

	async function test(): Promise<void> {
		if (!configured.value) {
			ElMessage.warning("请先填写当前服务商的 API 地址、Key 与模型名");
			return;
		}
		testing.value = true;
		testResult.value = null;
		try {
			testResult.value = await aiApi.test({ ...form });
		} catch (e) {
			testResult.value = { ok: false, latencyMs: 0, error: (e as Error).message };
		} finally {
			testing.value = false;
		}
	}

	/* ---------- 项目映射（内容仓/主题仓磁盘目录，保存后热生效）---------- */

	const mapping = ref<ProjectMappingStatus | null>(null);
	const mappingForm = ref({ contentDir: "", themeDir: "" });
	const mappingSaving = ref(false);
	const picking = ref("");
	const detectVisible = reactive({ content: false, theme: false });

	async function loadMapping(): Promise<void> {
		try {
			const r = await systemApi.mapping();
			mapping.value = r;
			mappingForm.value = { contentDir: r.contentDir, themeDir: r.themeDir };
		} catch (e) {
			ElMessage.error((e as Error).message);
		}
	}

	async function browseMapping(repo: "content" | "theme"): Promise<void> {
		if (picking.value) return;
		picking.value = repo;
		try {
			const r = await systemApi.pickFolder(
				repo === "content" ? "选择内容仓目录（Shirone-Content）" : "选择主题仓目录（Shirone）",
			);
			if (!r.canceled && r.folder) {
				if (repo === "content") mappingForm.value.contentDir = r.folder;
				else mappingForm.value.themeDir = r.folder;
			}
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			picking.value = "";
		}
	}

	function resetMappingDefault(repo: "content" | "theme"): void {
		if (!mapping.value) return;
		if (repo === "content") mappingForm.value.contentDir = mapping.value.defaultContentDir;
		else mappingForm.value.themeDir = mapping.value.defaultThemeDir;
	}

	async function saveMapping(repo: "content" | "theme"): Promise<void> {
		if (mappingSaving.value) return;
		mappingSaving.value = true;
		try {
			const r =
				repo === "content"
					? await systemApi.saveMapping({ contentDir: mappingForm.value.contentDir.trim() || null })
					: await systemApi.saveMapping({ themeDir: mappingForm.value.themeDir.trim() || null });
			mapping.value = r;
			mappingForm.value = { contentDir: r.contentDir, themeDir: r.themeDir };
			// 全局状态里的两仓路径已变，刷新给「关于」等展示用
			void sys.refresh();
			ElMessage.success("映射已保存并生效");
			if (r.warnings.length > 0) ElMessage.warning(r.warnings.join("；"));
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			mappingSaving.value = false;
		}
	}
</script>

<template>
	<el-dialog
		v-model="visible"
		title="设置"
		width="min(1480px, 96vw)"
		top="8vh"
		class="app-settings-dialog"
		:close-on-click-modal="false"
	>
		<div class="app-settings">
			<el-menu
				:default-active="section"
				class="app-settings-menu"
				@select="(key: string | number) => (section = key as Section)"
			>
				<el-menu-item index="ai">
					<el-icon><MagicStick /></el-icon>
					<span>AI助手</span>
				</el-menu-item>
				<el-menu-item index="mapping">
					<el-icon><FolderOpened /></el-icon>
					<span>项目映射</span>
				</el-menu-item>
				<el-menu-item index="about">
					<el-icon><InfoFilled /></el-icon>
					<span>关于</span>
				</el-menu-item>
			</el-menu>

			<div v-loading="loading" class="app-settings-panel">
				<!-- AI 助手 -->
				<template v-if="section === 'ai'">
					<div class="ai-columns">
						<!-- 第一列：服务商列表（行内删除；标题右侧：启用开关 + 新增） -->
						<div class="ai-provider-list">
							<div class="ai-col-head">
								<div class="ai-col-title">服务商</div>
								<div class="ai-col-head-right">
									<span class="ai-col-head-label" title="启用后编辑器与数据页出现 AI 辅助入口">启用</span>
									<el-switch v-model="form.enable" />
									<el-button circle title="新增服务商" @click="addProvider">
										<el-icon><Plus /></el-icon>
									</el-button>
								</div>
							</div>
							<div
								v-for="p in form.providers"
								:key="p.id"
								class="ai-provider-item"
								:class="{ 'is-active': p.id === form.activeId }"
								@click="form.activeId = p.id"
							>
								<span class="ai-provider-name">{{ p.name }}</span>
								<span class="ai-provider-meta">
									<el-tag
										size="small"
										:type="p.protocol === 'anthropic' ? 'success' : 'info'"
										disable-transitions
									>
										{{ p.protocol === "anthropic" ? "Anthropic" : "OpenAI" }}
									</el-tag>
									<el-button
										class="ai-provider-del"
										size="small"
										text
										title="删除该服务商"
										@click.stop="removeProvider(p)"
									>
										<el-icon><Delete /></el-icon>
									</el-button>
								</span>
							</div>
						</div>

						<!-- 第二列：连接配置（快速导入 + 该服务商全部参数） -->
						<div class="ai-col">
							<div class="ai-col-title">连接配置</div>
							<div class="quick-import">
								<div class="quick-import-title">快速导入（填入当前选中的服务商）</div>
								<el-input
									v-model="importText"
									type="textarea"
									:rows="4"
									placeholder="粘贴 Claude Code settings.json 的 env 配置"
								/>
								<div class="quick-import-actions">
									<el-button size="small" @click="runImport">解析并填入</el-button>
									<el-button
										v-if="importText !== '' || importResult"
										size="small"
										text
										@click="((importText = ''), (importResult = null))"
									>
										清空
									</el-button>
								</div>
								<div v-if="importResult" class="quick-import-result">
									<template v-if="importResult.recognized.length">
										<div class="quick-import-line">已识别</div>
										<el-tag
											v-for="k in importResult.recognized"
											:key="k"
											size="small"
											type="success"
											class="quick-tag"
											disable-transitions
										>
											{{ k }}
										</el-tag>
									</template>
									<template v-if="importResult.ignored.length">
										<div class="quick-import-line">已忽略</div>
										<el-tag
											v-for="k in importResult.ignored"
											:key="k"
											size="small"
											type="info"
											class="quick-tag"
											disable-transitions
										>
											{{ k }}
										</el-tag>
									</template>
								</div>
							</div>

							<el-form label-width="130px" label-position="left" @submit.prevent>
								<template v-if="current">
									<el-form-item label="名称">
										<el-input
											ref="nameInput"
											v-model="current.name"
											placeholder="如 Anthropic 官方 / GLM 中转"
											clearable
										/>
									</el-form-item>
									<el-form-item label="协议">
										<el-radio-group v-model="current.protocol">
											<el-radio-button value="anthropic">Anthropic</el-radio-button>
											<el-radio-button value="openai">OpenAI 兼容</el-radio-button>
										</el-radio-group>
									</el-form-item>
									<el-form-item label="API 地址">
										<el-input v-model="current.baseUrl" :placeholder="baseUrlPlaceholder" clearable />
									</el-form-item>
									<el-form-item label="API Key">
										<el-input
											v-model="current.apiKey"
											type="password"
											show-password
											placeholder="sk-…"
											clearable
										/>
									</el-form-item>
									<el-form-item label="主模型">
										<el-input
											v-model="current.model"
											placeholder="claude-sonnet-5 / glm-5.3 / gpt-4o-mini …"
											clearable
										/>
									</el-form-item>
									<el-form-item label="轻量模型">
										<el-input
											v-model="current.modelFast"
											placeholder="摘要、字段生成等简单任务用；留空同主模型"
											clearable
										/>
									</el-form-item>
									<el-form-item label="联网检索">
										<el-switch v-model="current.webSearch" />
										<span class="form-tip">音乐搜索等联网功能依赖，不支持时自动降级</span>
									</el-form-item>
									<el-form-item label="温度">
										<el-input-number v-model="current.temperature" :min="0" :max="2" :step="0.1" />
										<span class="form-tip">越高越发散，写作建议 0.4 - 0.8</span>
									</el-form-item>
									<el-form-item label="超时（秒）">
										<el-input-number
											v-model="current.timeoutSeconds"
											:min="5"
											:max="86400"
											:step="60"
										/>
									</el-form-item>
								</template>
							</el-form>
						</div>
					</div>

					<div class="ai-footer">
						<div v-if="testResult" class="test-result" :class="testResult.ok ? 'is-ok' : 'is-fail'">
							<template v-if="testResult.ok">
								连接成功（{{ testResult.latencyMs }}ms）：模型应答「{{ testResult.reply }}」
							</template>
							<template v-else>连接失败：{{ testResult.error }}</template>
						</div>

						<div class="actions">
							<el-button :loading="testing" :disabled="!configured" @click="test">
								测试连接
							</el-button>
							<el-button type="primary" :loading="saving" @click="save">保存</el-button>
						</div>
					</div>
				</template>

				<!-- 项目映射 -->
				<template v-else-if="section === 'mapping'">
					<div class="mapping-columns">
						<div class="mapping-card">
							<div class="mapping-head">
								<div class="mapping-title">
									内容仓
									<span class="mapping-sub">Shirone-Content，文章与媒体写入目标</span>
								</div>
								<el-tag v-if="mapping?.contentConnected" type="success" effect="plain">已连接</el-tag>
								<el-tag v-else type="danger" effect="plain">未连接</el-tag>
							</div>
							<el-input v-model="mappingForm.contentDir" placeholder="绝对路径，如 D:\blogs\Shirone-Content" clearable />
							<div class="mapping-ops">
								<el-button plain :loading="picking === 'content'" @click="browseMapping('content')">浏览…</el-button>
								<el-button plain @click="detectVisible.content = true">
									<el-icon><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 查找
								</el-button>
								<el-button text @click="resetMappingDefault('content')">恢复默认</el-button>
							</div>
							<div class="mapping-foot">
								<el-button type="primary" :loading="mappingSaving" @click="saveMapping('content')">保存</el-button>
								<span v-if="mapping?.contentCustom" class="mapping-note">自定义路径已写入 .env，重启后仍生效</span>
							</div>
							<DirDetectDialog
								v-model="detectVisible.content"
								target="content"
								@applied="(p: string) => (mappingForm.contentDir = p)"
							/>
						</div>

						<div class="mapping-card">
							<div class="mapping-head">
								<div class="mapping-title">
									主题仓
									<span class="mapping-sub">Shirone，校验与真站预览用</span>
								</div>
								<el-tag v-if="mapping?.themeConnected && mapping?.themeDepsInstalled" type="success" effect="plain">已连接</el-tag>
								<el-tag v-else-if="mapping?.themeConnected" type="warning" effect="plain">依赖未装</el-tag>
								<el-tag v-else type="danger" effect="plain">未连接</el-tag>
							</div>
							<el-input v-model="mappingForm.themeDir" placeholder="绝对路径，如 D:\blogs\Shirone" clearable />
							<div class="mapping-ops">
								<el-button plain :loading="picking === 'theme'" @click="browseMapping('theme')">浏览…</el-button>
								<el-button plain @click="detectVisible.theme = true">
									<el-icon><Icon icon="material-symbols:auto-awesome" /></el-icon>AI 查找
								</el-button>
								<el-button text @click="resetMappingDefault('theme')">恢复默认</el-button>
							</div>
							<div class="mapping-foot">
								<el-button type="primary" :loading="mappingSaving" @click="saveMapping('theme')">保存</el-button>
								<span v-if="mapping?.themeCustom" class="mapping-note">自定义路径已写入 .env，重启后仍生效</span>
							</div>
							<DirDetectDialog
								v-model="detectVisible.theme"
								target="theme"
								@applied="(p: string) => (mappingForm.themeDir = p)"
							/>
						</div>
					</div>
				</template>

				<!-- 关于 -->
				<template v-else>
					<el-descriptions :column="1" border>
						<el-descriptions-item label="工具">Shirone Admin — 博客内容可视化管理</el-descriptions-item>
						<el-descriptions-item label="内容仓">{{ sys.status?.contentDir ?? "…" }}</el-descriptions-item>
						<el-descriptions-item label="主题仓">{{ sys.status?.themeDir ?? "…" }}</el-descriptions-item>
						<el-descriptions-item label="Git 分支">
							{{ sys.status?.git?.branch ?? "—" }}
							<template v-if="(sys.status?.git?.ahead ?? 0) > 0">
								· 领先 {{ sys.status?.git?.ahead }} 个提交
							</template>
						</el-descriptions-item>
						<el-descriptions-item label="AI 设置存储">server/data/ai-settings.json（已 gitignore）</el-descriptions-item>
					</el-descriptions>
				</template>
			</div>
		</div>
	</el-dialog>
</template>
