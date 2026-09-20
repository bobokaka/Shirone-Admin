import { createApp } from "vue";
import { createPinia } from "pinia";
import ElementPlus from "element-plus";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import "md-editor-v3/lib/style.css";
import * as Icons from "@element-plus/icons-vue";
import App from "./App.vue";
import { router } from "./router";
import "./utils/icons"; // 注册内置离线图标集合（须先于任何 DataIcon 渲染执行）
import "./utils/md-editor-setup"; // 注入 mermaid 离线实例（编辑器/预览渲染共用）
import "./styles.css";

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ElementPlus, { locale: zhCn });
for (const [name, comp] of Object.entries(Icons)) {
	app.component(name, comp);
}
app.mount("#app");
