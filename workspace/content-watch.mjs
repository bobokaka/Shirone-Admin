// 一键启动：内容仓监听同步 + Astro dev server + Shirone-Admin（API server :5175 + Web client :5173）
// 用法：在 Shirone-Admin 仓库根执行 node workspace/content-watch.mjs（路径按脚本自身位置解析，不依赖 cwd）
// 流程：先启动 content:watch 做初始同步，检测到 "Watching" 后再启动 dev
//       （dev script 自带一次 sync，此时为增量空跑，避免两个 sync 并发写文件竞争）
//       Admin 与内容同步无依赖，立即并行启动（pnpm dev 会同时拉起 server 与 client）
// 输出：三端（astro / admin client / admin api）就绪后统一打印一次打开地址（OSC 8 可点击唤起默认浏览器）；不自动打开浏览器
// 生命周期：Astro 7 的 dev server 可能守护化——dev 进程启动完就退出、server 留在后台。
//       此时改用 `astro dev logs --follow` 跟随服务日志保持输出可见；
//       脚本退出（Ctrl+C / 任一进程死亡）统一 `astro dev stop` 收尾，不留孤儿 server。
// 注：Windows 下 spawn .cmd 必须带 shell:true，否则 Node 会抛 EINVAL
import { execSync, spawn } from "node:child_process";
import { join } from "node:path";

// 启动前清掉三个端口上的残留监听（上次异常退出留下的孤儿进程），保证全新起点
const cleanPorts = () => {
	for (const port of [4321, 5173, 5175]) {
		try {
			const out = execSync(`netstat -ano | findstr LISTENING | findstr ":${port} "`).toString();
			const pids = [
				...new Set(
					out
						.split(/\r?\n/)
						.map((line) => line.trim().split(/\s+/).pop())
						.filter((pid) => /^\d+$/.test(pid)),
				),
			];
			for (const pid of pids) {
				try {
					execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
					console.log(`[content-watch] 已清理端口 ${port} 上的残留进程 (pid ${pid})`);
				} catch {
					// 单个清理失败不阻塞
				}
			}
		} catch {
			// findstr 无匹配时非零退出，视为端口空闲
		}
	}
};

cleanPorts();

// 本脚本位于 <工作区>/Shirone-Admin/workspace/，工作区根需回溯两级
const wsRoot = join(import.meta.dirname, "..", "..");
const shironeDir = join(wsRoot, "Shirone");
const adminDir = join(wsRoot, "Shirone-Admin");
const spawnOpts = {
	cwd: shironeDir,
	shell: true,
	env: { ...process.env, CONTENT_DIR: "../Shirone-Content" },
};
const adminOpts = {
	cwd: adminDir,
	shell: true,
};

// ── 就绪探测与统一地址输出 ──────────────────────────────────────────
// 三端就绪一律 HTTP 探活：日志标记在 astro 守护化 + logs --follow 晚挂载时会漏掉 ready 框
const ready = { astro: false, adminApi: false, adminWeb: false };
const allReady = () => ready.astro && ready.adminApi && ready.adminWeb;
let announcedAll = false;
let announcedFallback = false;

// OSC 8 超链接：支持的终端（Windows Terminal / VS Code 等）点击即唤起默认浏览器；管道时退化为裸 URL
const link = process.stdout.isTTY
	? (url) => `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`
	: (url) => url;

const printAddresses = () => {
	console.log(`   博客    ${link("http://localhost:4321/")}`);
	console.log(`   Admin   ${link("http://localhost:5173/")}`);
	console.log(`   API     ${link("http://localhost:5175/")}  （Admin 内部使用）`);
};

const announceAll = () => {
	if (announcedAll) return;
	announcedAll = true;
	// 全部就绪后停止探活：否则每 2s 的探测请求会让 astro dev 持续刷 [200] / 请求日志
	clearInterval(probeTimer);
	console.log("");
	console.log("────────────────  全部就绪 · 打开地址  ────────────────");
	printAddresses();
	console.log("──────────────────────────────────────────────────────");
};

const maybeAnnounce = () => {
	if (allReady()) announceAll();
};

// 兜底：上游启动慢时先给出地址；之后全部就绪会再补发「全部就绪」块
setTimeout(() => {
	if (announcedAll || announcedFallback) return;
	announcedFallback = true;
	console.log("");
	console.log("─────  打开地址（部分服务可能仍在启动，请查看上方日志）  ─────");
	printAddresses();
	console.log("──────────────────────────────────────────────────────");
}, 30_000);

const probe = async (url) => {
	try {
		const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
		return r.status < 500;
	} catch {
		return false;
	}
};

const probeTimer = setInterval(async () => {
	ready.astro = await probe("http://127.0.0.1:4321/");
	ready.adminWeb = await probe("http://127.0.0.1:5173/");
	ready.adminApi = await probe("http://127.0.0.1:5175/api/status");
	maybeAnnounce();
}, 2000);

// 纯转发子进程输出（就绪判定走上面的 HTTP 探活）
const pipeThrough = (child) => {
	child.stdout?.on("data", (chunk) => process.stdout.write(chunk));
	child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
};

// shell:true 会产生 cmd.exe 包裹层，taskkill /T 连树一起杀，避免残留孤儿进程
const killTree = (child) => {
	if (child?.pid && child.exitCode === null) {
		spawn(`taskkill /pid ${child.pid} /T /F`, { shell: true, stdio: "ignore" });
	}
};

let watch, dev, logs, admin;
let shuttingDown = false;

const shutdown = () => {
	if (shuttingDown) return;
	shuttingDown = true;
	killTree(logs);
	killTree(dev);
	killTree(admin);
	killTree(watch);
	// dev server 守护化时 dev 进程早已退出，需显式停掉后台 server（前台模式下为无害空操作）
	spawn("npx.cmd astro dev stop", { ...spawnOpts, stdio: "ignore" });
};

const followDaemonLogs = () => {
	if (logs || shuttingDown) return;
	logs = spawn("npx.cmd astro dev logs --follow", {
		...spawnOpts,
		stdio: ["ignore", "pipe", "pipe"],
	});
	pipeThrough(logs);
	logs.on("exit", (code) => {
		// 非 shutdown 场景下 logs 退出说明后台 server 已死亡，联动结束整个脚本
		if (!shuttingDown) {
			process.exitCode = code ?? 0;
			shutdown();
		}
	});
};

const startDev = () => {
	if (dev || logs || shuttingDown) return;
	dev = spawn("pnpm.cmd dev", { ...spawnOpts, stdio: ["ignore", "pipe", "pipe"] });
	pipeThrough(dev);
	dev.on("exit", (code) => {
		if (shuttingDown) return;
		// dev 进程退出有两种可能：server 已守护化（跟随日志），或启动失败（跟随日志会报
		// "no running dev server"，用户可见，随后联动退出）
		if (code === 0 || code === 1) followDaemonLogs();
		else {
			process.exitCode = code ?? 0;
			shutdown();
		}
	});
};

const startAdmin = () => {
	if (admin || shuttingDown) return;
	admin = spawn("pnpm.cmd dev", { ...adminOpts, stdio: ["ignore", "pipe", "pipe"] });
	pipeThrough(admin);
	admin.on("exit", (code) => {
		if (shuttingDown) return;
		// Admin 任一子包（server/client）失败都会联动结束整个脚本，与 watch/dev 行为一致
		process.exitCode = code ?? 0;
		shutdown();
	});
};

watch = spawn("pnpm.cmd content:watch --quiet", {
	...spawnOpts,
	stdio: ["ignore", "pipe", "pipe"],
});
watch.stdout.on("data", (chunk) => {
	process.stdout.write(chunk);
	if (chunk.includes("Watching")) startDev();
});
watch.stderr.on("data", (chunk) => process.stderr.write(chunk));
watch.on("exit", (code) => {
	if (!shuttingDown) {
		process.exitCode = code ?? 0;
		shutdown();
	}
});

startAdmin();

// 兜底：若上游输出文案变化导致匹配不到 "Watching"，10 秒后仍启动 dev
setTimeout(startDev, 10_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, shutdown);
}
