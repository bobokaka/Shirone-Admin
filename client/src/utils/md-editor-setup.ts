/**
 * md-editor-v3 全局配置。
 * mermaid 实例离线注入：库默认经 CDN script 动态加载（useMermaid 的 appendHandler 分支），
 * 本工具不访问在线资源，直接注入 npm 包实例即可短路该分支；渲染主题由库按编辑器明暗
 * 自动切换（dark/default），无需在此配置。
 */
import mermaid from "mermaid";
import { config } from "md-editor-v3";

config({
	editorExtensions: {
		mermaid: { instance: mermaid },
	},
});
