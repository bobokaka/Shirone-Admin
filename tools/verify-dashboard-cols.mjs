// 一次性验证：仪表盘底部两卡左右并列且等高，动态条目渲染
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
await page.waitForTimeout(2000);

const r = await page.evaluate(() => {
	const cards = [...document.querySelectorAll(".bottom-row .el-col > .el-card")];
	const headers = cards.map((c) => c.querySelector(".el-card__header")?.textContent?.trim());
	const rects = cards.map((c) => {
		const b = c.getBoundingClientRect();
		return { h: Math.round(b.height), x: Math.round(b.x) };
	});
	const momentsItems = document.querySelectorAll(".bottom-row .recent li").length;
	const momentText = [...document.querySelectorAll(".bottom-row .clamp")].map((e) => e.textContent?.slice(0, 12));
	return { headers, rects, momentsItems, momentText };
});
console.log(JSON.stringify(r, null, 1));
console.log(
	r.headers.join(",") === "最近文章,最近动态" && r.rects[0].x < r.rects[1].x && r.rects[0].h === r.rects[1].h
		? "左右并列且等高 ✓"
		: "布局异常 ✗",
);

await browser.close();
