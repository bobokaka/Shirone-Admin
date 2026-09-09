import { execa } from "execa";
import { CONTENT_DIR, THEME_DIR } from "../config.js";

/**
 * 真站预览：拉起主题仓 `content:watch`（保存即同步）与 `astro dev`（:4321）。
 * Windows 下经 `cmd /c` 调 .cmd 脚本；停止时 taskkill 杀进程树。
 */

interface ChildLike {
	pid?: number;
	kill: (signal?: string, options?: { forceKillAfterDelay?: number }) => unknown;
}

interface Proc {
	name: string;
	proc: ChildLike;
}

const running = new Map<string, Proc>();

function spawnProc(name: string, args: string[]): void {
	const child = execa("cmd", ["/c", ...args], {
		cwd: THEME_DIR,
		env: { ...process.env, CONTENT_DIR },
		all: true,
	});
	child.catch(() => {}); // 进程退出/被杀时避免 unhandled rejection
	running.set(name, { name, proc: child as unknown as ChildLike });
}

function alive(p: ChildLike): boolean {
	try {
		return typeof p.pid === "number" && process.kill(p.pid, 0);
	} catch {
		return false;
	}
}

async function killTree(name: string): Promise<void> {
	const item = running.get(name);
	if (!item) return;
	running.delete(name);
	if (!alive(item.proc)) return;
	if (process.platform === "win32" && item.proc.pid) {
		await execa("taskkill", ["/pid", String(item.proc.pid), "/T", "/F"], { reject: false });
	} else {
		item.proc.kill("SIGTERM", { forceKillAfterDelay: 3000 });
	}
}

export async function previewStart(): Promise<{ started: boolean; message: string }> {
	if (running.size > 0) {
		return { started: false, message: "预览已在运行" };
	}
	spawnProc("watch", ["pnpm.cmd", "content:watch"]);
	spawnProc("astro", ["pnpm.cmd", "dev"]);
	return { started: true, message: "真站预览已启动，首次启动需等待依赖编译" };
}

export async function previewStop(): Promise<{ stopped: boolean }> {
	for (const name of [...running.keys()]) {
		await killTree(name);
	}
	return { stopped: true };
}

async function siteReady(): Promise<boolean> {
	try {
		const r = await fetch("http://localhost:4321/", { signal: AbortSignal.timeout(1200) });
		return r.ok;
	} catch {
		return false;
	}
}

export async function previewStatus(): Promise<{ running: boolean; ready: boolean; procs: string[] }> {
	const procs = [...running.keys()].filter((n) => {
		const item = running.get(n);
		return item && alive(item.proc);
	});
	for (const name of [...running.keys()]) {
		if (!procs.includes(name)) running.delete(name);
	}
	// ready 只看 4321 是否可达：dev server 可能来自 admin、content-watch.mjs 或任何终端，
	// 能打开就直接嵌入预览，不必也不应重复拉起编译
	const ready = await siteReady();
	return { running: procs.length > 0, ready, procs };
}
