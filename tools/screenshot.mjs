// 视觉验收：用主题仓（../Shirone）已装的 Playwright 给 admin 页面截图
// 前置：先起动 `pnpm dev`（server:5175 + client:5173）
// 用法：node tools/screenshot.mjs [输出目录，默认 tools/.shots]
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";

// ESM 不能跨包解析，借 createRequire 挂到主题仓的 node_modules
const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const outDir = process.argv[2] ?? path.join(import.meta.dirname, ".shots");
mkdirSync(outDir, { recursive: true });

const pages = [
	["dashboard", "/dashboard"],
	["posts", "/posts"],
	["post-edit", "/posts/edit?path=guide.md"],
	["moments", "/moments"],
	["publish", "/publish"],
];

// 本机 ms-playwright 无浏览器二进制，直接复用系统 Chrome
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// 网络取证：记录 /api 响应码与失败请求
page.on("response", (res) => {
	if (res.url().includes("/api/")) console.log("[net]", res.status(), res.request().method(), res.url());
});
page.on("requestfailed", (req) => {
	console.log("[net-fail]", req.failure()?.errorText, req.method(), req.url());
});
page.on("console", (msg) => {
	if (msg.type() === "error") console.log("[console]", msg.text().slice(0, 200));
});

for (const [name, url] of pages) {
	await page.goto(`http://127.0.0.1:5173${url}`, { waitUntil: "load" });
	await page.waitForTimeout(1800);
	// 顶部时间戳水印：保证每次截图字节唯一，并可用于确认分析的是哪一次渲染
	await page.evaluate(() => {
		const badge = document.createElement("div");
		badge.textContent = `SHOT ${new Date().toISOString().slice(11, 19)}`;
		badge.style.cssText =
			"position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;background:#111;color:#0f0;padding:1px 8px;font:12px monospace;border-radius:0 0 6px 6px;";
		document.body.appendChild(badge);
	});
	await page.screenshot({ path: path.join(outDir, `${name}.png`) });
	console.log("[shot]", name);
}

await browser.close();
console.log("done →", outDir);
