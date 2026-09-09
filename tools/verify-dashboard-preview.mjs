// 一次性验证：仪表盘底部真站预览——4321 可达时直接嵌入且不点火
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

const fake = http.createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html" });
	res.end("<html><body>fake-astro</body></html>");
});
await new Promise((r) => fake.listen(4321, "127.0.0.1", r));

await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
await page.waitForTimeout(3000);

const r = await page.evaluate(() => {
	const card = [...document.querySelectorAll(".el-card")].find(
		(c) =>
			c.querySelector(".el-card__header")?.textContent?.includes("真站预览") &&
			c.querySelector(".bar"),
	);
	if (!card) return null;
	const iframe = card.querySelector("iframe");
	const b = iframe?.getBoundingClientRect();
	return {
		hasCard: true,
		iframe: !!iframe,
		iframeH: b ? Math.round(b.height) : 0,
		text: card.innerText.slice(0, 80),
	};
});
console.log(JSON.stringify(r));
console.log("底部卡存在:", r?.hasCard ? "✓" : "✗");
console.log("自动嵌入 iframe:", r?.iframe ? "✓" : "✗");
console.log("仪表盘加载未点火:", startCalled ? "✗" : "✓");
console.log("高度:", r?.iframeH);

fake.closeAllConnections?.();
await new Promise((r2) => fake.close(r2));
await browser.close();
