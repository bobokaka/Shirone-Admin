// 一次性验证：4321 已可达时不点火只嵌入；不可达时才自动点火
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const http = await import("node:http");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

let startCalled = false;
page.on("request", (req) => {
	if (req.url().includes("/api/preview/start")) startCalled = true;
});

async function openDialog() {
	await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
	await page.waitForTimeout(1200);
	startCalled = false;
	await page.getByRole("button", { name: "启动预览" }).click();
	await page.waitForTimeout(2500);
}

async function closeDialog() {
	await page.keyboard.press("Escape");
	await page.waitForTimeout(600);
}

// ---------- 场景 A：4321 已有服务（模拟外部 dev server） ----------
const fake = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end("<html><body>fake-astro</body></html>");
});
await new Promise((r) => fake.listen(4321, "127.0.0.1", r));

await openDialog();
const aText = await page.evaluate(() => document.body.innerText);
const aIframe = await page.evaluate(() => !!document.querySelector(".el-dialog iframe"));
console.log("A. 外部已运行:");
console.log("   点火请求:", startCalled ? "被触发 ✗" : "未触发 ✓");
console.log("   iframe 嵌入:", aIframe ? "✓" : "✗");
console.log("   提示文案:", aText.includes("检测到 dev server") ? "✓" : `✗ (${aText.includes("站点就绪") ? "显示站点就绪" : "无相关文案"})`);

await closeDialog();
fake.closeAllConnections?.();
await new Promise((r) => fake.close(r));
await new Promise((r) => setTimeout(r, 800));

// ---------- 场景 B：4321 无服务 ----------
await openDialog();
const bReady = await page.evaluate(() => !!document.querySelector(".el-dialog iframe"));
console.log("B. 无服务:");
console.log("   点火请求:", startCalled ? "已触发 ✓" : "未触发 ✗");
console.log("   未就绪时不嵌 iframe:", bReady ? "✗(嵌了)" : "✓");

await browser.close();
