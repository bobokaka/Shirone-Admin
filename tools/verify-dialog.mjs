// 一次性验证：菜单无真站预览 + 仪表盘按钮开弹窗并自动点火
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
await page.waitForTimeout(1500);

const menuText = await page.evaluate(() => document.querySelector(".el-menu")?.innerText ?? "");
console.log("菜单含真站预览:", menuText.includes("真站预览") ? "存在 ✗" : "已删除 ✓");

let startCalled = false;
page.on("request", (req) => {
	if (req.url().includes("/api/preview/start")) startCalled = true;
});

await page.getByRole("button", { name: "启动预览" }).click();
await page.waitForTimeout(2000);
const dialogVisible = await page.evaluate(() => {
	const d = document.querySelector(".el-dialog");
	return !!d && d.querySelector(".el-dialog__title")?.textContent === "真站预览";
});
console.log("弹窗打开:", dialogVisible ? "✓" : "✗");
console.log("自动点火:", startCalled ? "✓" : "✗");

await browser.close();
