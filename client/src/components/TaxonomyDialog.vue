<script setup lang="ts">
	import { computed, ref, watch } from "vue";
	import { ElMessage, ElMessageBox } from "element-plus";
	import type { PostMeta, TaxonomyKind } from "@shirone-admin/shared";
	import { postApi, taxonomyApi } from "../api";

	const visible = defineModel<boolean>({ default: false });
	const emit = defineEmits<{ (e: "renamed"): void }>();

	const kind = ref<TaxonomyKind>("category");
	const posts = ref<PostMeta[]>([]);
	const loading = ref(false);
	const working = ref(false);

	interface TaxonomyRow {
		name: string;
		count: number;
	}

	const rows = computed<TaxonomyRow[]>(() => {
		const counter = new Map<string, number>();
		for (const p of posts.value) {
			if (kind.value === "category") {
				if (p.category) counter.set(p.category, (counter.get(p.category) ?? 0) + 1);
			} else {
				for (const t of p.tags) counter.set(t, (counter.get(t) ?? 0) + 1);
			}
		}
		return [...counter.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
	});

	async function load(): Promise<void> {
		loading.value = true;
		try {
			posts.value = await postApi.list();
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			loading.value = false;
		}
	}

	watch(visible, (v) => {
		if (v) load();
	});

	async function rename(row: TaxonomyRow): Promise<void> {
		const label = kind.value === "category" ? "分类" : "标签";
		const { value } = await ElMessageBox.prompt(
			`把「${row.name}」重命名或合并到…（填已存在的名字即合并；留空并确认 = 从 ${row.count} 篇文章中移除）`,
			`重命名${label}`,
			{
				confirmButtonText: "确定",
				cancelButtonText: "取消",
				inputPlaceholder: `新的${label}名（可留空）`,
				inputValue: row.name,
			},
		).catch(() => ({ value: null as string | null }));
		if (value === null) return;
		const to = value.trim();
		if (to === row.name) return;

		working.value = true;
		try {
			const r = await taxonomyApi.rename({ kind: kind.value, from: row.name, to });
			ElMessage.success(to ? `已改写 ${r.changed} 篇文章` : `已从 ${r.changed} 篇文章中移除`);
			await load();
			emit("renamed");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			working.value = false;
		}
	}

	async function remove(row: TaxonomyRow): Promise<void> {
		const label = kind.value === "category" ? "分类" : "标签";
		await ElMessageBox.confirm(
			`从 ${row.count} 篇文章中移除「${row.name}」？（不删除文章本身）`,
			`移除${label}`,
			{ type: "warning", confirmButtonText: "移除", cancelButtonText: "取消" },
		);
		working.value = true;
		try {
			const r = await taxonomyApi.rename({ kind: kind.value, from: row.name, to: "" });
			ElMessage.success(`已从 ${r.changed} 篇文章中移除`);
			await load();
			emit("renamed");
		} catch (e) {
			ElMessage.error((e as Error).message);
		} finally {
			working.value = false;
		}
	}
</script>

<template>
	<el-dialog v-model="visible" title="分类 / 标签管理" width="560px" top="8vh">
		<el-tabs v-model="kind">
			<el-tab-pane label="分类" name="category" />
			<el-tab-pane label="标签" name="tag" />
		</el-tabs>
		<el-alert
			type="info"
			:closable="false"
			show-icon
			:title="kind === 'category' ? '分类直接改写每篇文章 frontmatter 的 category 字段' : '标签批量改写/合并/移除，自动去重'"
			class="tip"
		/>
		<el-table v-loading="loading" :data="rows" max-height="46vh" stripe>
			<el-table-column prop="name" :label="kind === 'category' ? '分类名' : '标签名'" min-width="160" />
			<el-table-column prop="count" label="文章数" width="90" sortable />
			<el-table-column label="操作" width="180">
				<template #default="{ row }">
					<el-button size="small" :loading="working" @click="rename(row)">重命名 / 合并</el-button>
					<el-button size="small" type="danger" plain :loading="working" @click="remove(row)">移除</el-button>
				</template>
			</el-table-column>
		</el-table>
		<el-empty v-if="!loading && rows.length === 0" :description="kind === 'category' ? '还没有文章使用分类' : '还没有文章使用标签'" />
	</el-dialog>
</template>

<style scoped>
	.tip {
		margin-bottom: 12px;
	}
</style>
