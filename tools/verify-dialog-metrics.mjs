// 一次性验证：弹窗上下边距各 10px
import { createRequire } from "node:module";

const require = createRequire(new URL("../../Shirone/package.json", import.meta.url));
const { chromium } = require("@playwright/test");

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://127.0.0.1:5173/dashboard", { waitUntil: "load" });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "启动预览" }).click();
await page.waitForTimeout(1200);

const m = await page.evaluate(() => {
	const d = document.querySelector(".el-dialog.preview-dialog");
	if (!d) return null;
	const r = d.getBoundingClientRect();
	return {
		top: Math.round(r.top),
		bottomGap: Math.round(window.innerHeight - r.bottom),
		height: Math.round(r.height),
		viewH: window.innerHeight,
		iframe: !!document.querySelector(".el-dialog.preview-dialog iframe, .el-dialog.preview-dialog .el-empty"),
	};
});
console.log("dialog metrics:", JSON.stringify(m));
if (m) {
	console.log(
		m.top === 10 && m.bottomGap === 10 ? "上下边距 10px ✓" : `边距异常 ✗ (top=${m.top}, bottomGap=${m.bottomGap})`,
	);
}

await browser.close();
