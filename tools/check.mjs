// 功能断言：不起眼病的眼睛，直接读 DOM 文本验证页面真实状态
// 用法：node tools/check.mjs
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const bad = [];
await page.on("response", (res) => {
	if (res.url().includes("/api/") && res.status() >= 400) bad.push(`${res.status()} ${res.url()}`);
});

for (const [name, url] of [
	["dashboard", "/dashboard"],
	["posts", "/posts"],
	["moments", "/moments"],
]) {
	await page.goto(`http://127.0.0.1:5173${url}`, { waitUntil: "load" });
	await page.waitForTimeout(1500);
	const text = await page.evaluate(() => document.body.innerText);
	console.log(`=== ${name}`);
	console.log("  内容仓:", text.includes("已连接") ? "已连接 ✓" : text.includes("未连接") ? "未连接 ✗" : "无状态字样");
	console.log("  500字样:", text.includes("500") ? "存在 ✗" : "无 ✓");
	console.log("  文章可见:", /guide|欢迎使用|Markdown/.test(text) ? "有 ✓" : name === "moments" ? "(不适用)" : "无");
}

await browser.close();
console.log("=== 4xx/5xx 请求:", bad.length ? bad : "无");
