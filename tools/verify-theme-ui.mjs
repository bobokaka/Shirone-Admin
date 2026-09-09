// 功能断言：主题外观页 tab 化 + 底部真站预览 + 多语言控制
// 前置：先起动 `pnpm dev`（server:5175 + client:5173）
// 用法：node tools/verify-theme-ui.mjs
import { createRequire } from "node:module";

// ESM 不能跨包解析，借 createRequire 挂到主题仓的 node_modules
const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const badResponses = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("response", (res) => {
	if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`);
});

await page.goto("http://localhost:5173/theme", { waitUntil: "networkidle" });
await page.waitForTimeout(2500);

const tabs = await page.locator(".el-tabs__item").allTextContents();
console.log("tabs:", JSON.stringify(tabs));

const toolbar = await page.locator(".page-toolbar button").allTextContents();
console.log("toolbar buttons:", JSON.stringify(toolbar));

await page.screenshot({ path: "tools/verify-theme-color.png", fullPage: false });

// 布局几何断言：tab 栏在上、预览在下，预览高度约 42vh
const tabBar = await page.locator(".el-tabs__header").boundingBox();
const preview = await page.locator(".theme-preview").boundingBox();
console.log(
	"layout:",
	JSON.stringify({
		tabBarY: tabBar?.y,
		previewY: preview?.y,
		previewH: preview?.height,
		previewBelowTabs: Boolean(tabBar && preview && preview.y > tabBar.y),
	}),
);
const frame = page.locator(".theme-preview iframe");
console.log("iframe src:", await frame.getAttribute("src"), "visible:", await frame.isVisible());

await page.locator(".el-tabs__item", { hasText: "多语言" }).click();
await page.waitForTimeout(400);
console.log(
	"i18n tab(before enable): switches:",
	await page.locator(".el-tab-pane:visible .el-switch").count(),
	"checkboxes:",
	await page.locator(".el-tab-pane:visible .el-checkbox").count(),
);

await page.locator(".el-tab-pane:visible .el-switch").first().click();
await page.waitForTimeout(400);
console.log(
	"i18n tab(after enable): checkboxes:",
	await page.locator(".el-tab-pane:visible .el-checkbox").count(),
	"checked:",
	await page.locator(".el-tab-pane:visible .el-checkbox.is-checked").count(),
	"selects:",
	await page.locator(".el-tab-pane:visible .el-select").count(),
);
await page.screenshot({ path: "tools/verify-theme-i18n-on.png", fullPage: false });

console.log(errors.length ? `JS errors:\n${errors.join("\n")}` : "no JS errors");
console.log(
	badResponses.length ? `bad responses:\n${badResponses.join("\n")}` : "no bad responses",
);
await browser.close();
