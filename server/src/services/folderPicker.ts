import { execa } from "execa";
import type { FilePickResult, FolderPickResult } from "@shirone-admin/shared";
import { ApiError } from "../lib/errors.js";

/**
 * 系统对话框（Windows Forms，经 PowerShell STA 线程弹出）。
 * 取消时不输出，超时 15 分钟兜底防僵尸进程；本地单机工具，请求挂起等待用户选择是预期行为。
 * 首行统一把 stdout 输出编码设为 UTF-8：中文 Windows 控制台默认 GBK，路径含中文会被解码成乱码。
 */

function psLiteral(text: string): string {
	return `'${text.replace(/'/g, "''")}'`;
}

async function runDialog(title: string, body: string[]): Promise<string> {
	const script = [
		"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
		"Add-Type -AssemblyName System.Windows.Forms | Out-Null",
		"$owner = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false}",
		...body,
	].join("\n");
	const result = await execa("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script], {
		timeout: 15 * 60_000,
		windowsHide: true,
		reject: false,
	});
	if (result.exitCode !== 0) {
		const detail = (result.stderr || "未知错误").split(/\r?\n/)[0]?.slice(0, 200).trim();
		throw new ApiError(502, `系统对话框不可用：${detail}，请改用拖入方式`);
	}
	return result.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() ?? "";
}

export async function pickFolder(title: string): Promise<FolderPickResult> {
	const folder = await runDialog(title, [
		"$d = New-Object System.Windows.Forms.FolderBrowserDialog",
		`$d.Description = ${psLiteral(title)}`,
		"$d.ShowNewFolderButton = $false",
		"if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
	]);
	return folder ? { canceled: false, folder } : { canceled: true };
}

/** 单选文件对话框（当前用于选 md 文章；拿到绝对路径后由 server 直读其所在目录的媒体） */
export async function pickFile(title: string): Promise<FilePickResult> {
	const file = await runDialog(title, [
		"$d = New-Object System.Windows.Forms.OpenFileDialog",
		`$d.Title = ${psLiteral(title)}`,
		"$d.Filter = 'Markdown|*.md;*.markdown'",
		"$d.CheckFileExists = $true",
		"if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
	]);
	return file ? { canceled: false, path: file } : { canceled: true };
}
