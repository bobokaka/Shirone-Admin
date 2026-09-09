// 一次性验证：仪表盘四卡等高 + /preview?autostart=1 自动点火
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 1) 等高验证
await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
await page.waitForTimeout(1500);
const heights = await page.evaluate(() =>
	[...document.querySelectorAll(".el-row .el-col > .el-card")].map(
		(el) => Math.round(el.getBoundingClientRect().height),
	),
);
console.log("card heights:", heights, "→", new Set(heights).size === 1 ? "等高 ✓" : "不等高 ✗");

// 2) 自动点火验证：进入 /preview?autostart=1 应触发 /api/preview/start
let startCalled = false;
page.on("request", (req) => {
	if (req.url().includes("/api/preview/start")) startCalled = true;
});
await page.goto("http://127.0.0.1:5173/preview?autostart=1", { waitUntil: "load" });
await page.waitForTimeout(2500);
console.log("autostart 请求:", startCalled ? "已触发 ✓" : "未触发 ✗");

await browser.close();
