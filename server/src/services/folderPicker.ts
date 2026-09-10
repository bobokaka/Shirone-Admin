import { execa } from "execa";
import type { FolderPickResult } from "@shirone-admin/shared";
import { ApiError } from "../lib/errors.js";

/**
 * 系统文件夹选择对话框（Windows FolderBrowserDialog）。
 * 经 PowerShell STA 线程弹出；取消时不输出，超时 15 分钟兜底防僵尸进程。
 * 本地单机工具，请求挂起等待用户选择是预期行为。
 */

function psLiteral(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

function dialogScript(title: string): string {
	return [
		"Add-Type -AssemblyName System.Windows.Forms | Out-Null",
		"$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}",
		"$d = New-Object System.Windows.Forms.FolderBrowserDialog",
		`$d.Description = ${psLiteral(title)}`,
		"$d.ShowNewFolderButton = $false",
		"if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
	].join("\n");
}

export async function pickFolder(title: string): Promise<FolderPickResult> {
	const result = await execa(
		"powershell.exe",
		["-NoProfile", "-NonInteractive", "-STA", "-Command", dialogScript(title)],
		{ timeout: 15 * 60_000, windowsHide: true, reject: false },
	);
	if (result.exitCode !== 0) {
		const detail = (result.stderr || "未知错误").split(/\r?\n/)[0]?.slice(0, 200).trim();
		throw new ApiError(502, `系统文件夹对话框不可用：${detail}，请手动输入路径`);
	}
	const folder = result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
	return folder ? { canceled: false, folder } : { canceled: true };
}
