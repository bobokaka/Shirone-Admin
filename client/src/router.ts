import { createRouter, createWebHistory } from "vue-router";

export const router = createRouter({
	history: createWebHistory(),
	routes: [
		{ path: "/", redirect: "/dashboard" },
		{
			path: "/dashboard",
			component: () => import("./views/DashboardView.vue"),
			meta: { title: "仪表盘" },
		},
		{
			path: "/posts",
			component: () => import("./views/PostListView.vue"),
			meta: { title: "文章管理" },
		},
		{
			path: "/posts/edit",
			component: () => import("./views/PostEditorView.vue"),
			meta: { title: "文章编辑" },
		},
		{
			path: "/moments",
			component: () => import("./views/MomentsView.vue"),
			meta: { title: "说说动态" },
		},
		{
			path: "/data",
			component: () => import("./views/DataView.vue"),
			meta: { title: "数据管理" },
		},
		{
			path: "/import",
			component: () => import("./views/ImportView.vue"),
			meta: { title: "平台导入" },
		},
		{
			path: "/settings",
			component: () => import("./views/SettingsView.vue"),
			meta: { title: "站点设置" },
		},
		{ path: "/theme", redirect: "/settings" },
		{
			path: "/publish",
			component: () => import("./views/PublishView.vue"),
			meta: { title: "提交和发布" },
		},
	],
});

router.afterEach((to) => {
	document.title = to.meta.title ? `${to.meta.title} · Shirone Admin` : "Shirone Admin";
});
