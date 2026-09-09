// 一键部署：构建 → 压缩 → 上传（后删除本地 dist.zip）→ 服务器备份旧版（oldyyyy-mm-dd.zip）→ 清理旧文件 → 解压上线
// 前置：SSH 免密登录已配置（见 README 或下方提示），服务器需有 zip/unzip；
//       仓库根 .env 配置 DEPLOY_HOST 与 DEPLOY_REMOTE_DIR（模板见 .env.example）
// 用法：在 Shirone-Admin 仓库根执行 node workspace/deploy.mjs（路径按脚本自身位置解析，不依赖 cwd）
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

// 本脚本位于 <工作区>/Shirone-Admin/workspace/，工作区根需回溯两级
const SHIRONE = join(import.meta.dirname, "..", "..", "Shirone");
const DIST = join(SHIRONE, "dist");

try {
	process.loadEnvFile(join(import.meta.dirname, "..", ".env"));
} catch {
	// .env 不存在
}
const HOST = process.env.DEPLOY_HOST;
const REMOTE_DIR = process.env.DEPLOY_REMOTE_DIR;
if (!HOST || !REMOTE_DIR) {
	console.error("[deploy] 缺少部署配置：请在仓库根 .env 中设置 DEPLOY_HOST 与 DEPLOY_REMOTE_DIR（模板见 .env.example）");
	process.exit(1);
}

function run(name, cmd, args = [], opts = {}) {
	console.log(`\n==> ${name}`);
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if (r.status !== 0) {
		console.error(`\n[deploy] 步骤失败（exit ${r.status}）：${name}`);
		process.exit(r.status ?? 1);
	}
}

// 1. 构建
run("pnpm build", "pnpm.cmd build", [], { cwd: SHIRONE, shell: true });
if (!existsSync(DIST)) {
	console.error("[deploy] dist/ 不存在，构建可能未成功");
	process.exit(1);
}

// 2. 压缩 dist/ 内容（bsdtar -a 按扩展名产出 zip，条目为正斜杠路径，Linux 解压友好）
const zipPath = join(SHIRONE, "dist.zip");
rmSync(zipPath, { force: true });
run("压缩 dist/ → dist.zip", "tar", ["-a", "-c", "-f", zipPath, "."], { cwd: DIST });

// 3. 服务器：清旧备份 + 把当前线上版本备份为 oldyyyy-mm-dd.zip
run("服务器备份当前版本", "ssh", [
	HOST,
	`mkdir -p ${REMOTE_DIR} && cd ${REMOTE_DIR} && rm -f old*.zip && zip -qr old$(date +%F).zip . -x "*.zip"`,
]);

// 4. 上传新包（相对路径传给 scp，避免盘符冒号被解析成主机名），上传成功后删除本地 dist.zip
run("上传 dist.zip", "scp", ["dist.zip", `${HOST}:${REMOTE_DIR}/dist.zip`], { cwd: SHIRONE });
rmSync(zipPath, { force: true });

// 5. 服务器：清空旧文件（保留 *.zip 备份）→ 覆盖解压 → 删包
run("服务器解压上线", "ssh", [
	HOST,
	`cd ${REMOTE_DIR} && find . -mindepth 1 -maxdepth 1 ! -name "*.zip" -exec rm -rf {} + && unzip -o -q dist.zip && rm -f dist.zip`,
]);

console.log("\n[deploy] 部署完成。回滚方式：解压对应 oldyyyy-mm-dd.zip 即可。");
