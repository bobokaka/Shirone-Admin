import { computed, ref } from "vue";

/** 全局明暗主题：Element Plus 暗色由 html.dark + dark/css-vars.css 驱动。
 *  首选 localStorage 持久化选择，否则跟随系统 prefers-color-scheme。
 *  index.html 内联脚本在应用挂载前做同样的初始化，避免首屏闪错主题。 */

const STORAGE_KEY = "shirone-admin-theme";

function initialTheme(): "light" | "dark" {
	const saved = localStorage.getItem(STORAGE_KEY);
	if (saved === "light" || saved === "dark") return saved;
	return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const theme = ref<"light" | "dark">(initialTheme());
const isDark = computed(() => theme.value === "dark");

function apply(): void {
	document.documentElement.classList.toggle("dark", theme.value === "dark");
}

apply();

export function useTheme() {
	function toggle(): void {
		theme.value = theme.value === "dark" ? "light" : "dark";
		localStorage.setItem(STORAGE_KEY, theme.value);
		apply();
	}

	return { isDark, toggle };
}
