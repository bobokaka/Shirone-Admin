#!/usr/bin/env node
// sync-fork.mjs —— 上游同步工具（手动按需触发）
//
// 背景：两仓已脱离 GitHub fork 网络（仅为仓库私有化，上游 LyraVoid 仍持续开发），
// 用本脚本保留「上游跟进」能力。模型：
//   - sync-fork 分支 = 上游 main 的纯净镜像，不承载任何定制
//   - 本脚本只把 sync-fork 快进到上游 main，绝不触碰 main
//   - 是否把上游变更合并进 main 由人工审查后决定（git merge sync-fork）
//
// 用法（在 Shirone-Admin 仓库根执行，路径按脚本自身位置解析，不依赖 cwd）：
//   node workspace/sync-fork.mjs            # 更新两仓的 sync-fork 镜像分支
//   node workspace/sync-fork.mjs check      # 只查看差异，不改动
//   node workspace/sync-fork.mjs shirone    # 只处理主题仓
//   node workspace/sync-fork.mjs content    # 只处理内容仓
//   任意组合追加 --push             # 更新后把 sync-fork 推到 origin（默认只动本地）
//
// 约定：禁止对 main 做任何 force 操作；sync-fork 若与上游分叉（有人往镜像分支提交过），
// git 会拒绝非快进更新，脚本只报告，由人工确认后自行处理。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 本脚本位于 <工作区>/Shirone-Admin/workspace/，工作区根需回溯两级
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const repos = [
  { name: 'shirone', dir: 'Shirone', upstream: 'https://github.com/LyraVoid/Shirone.git' },
  { name: 'content', dir: 'Shirone-Content', upstream: 'https://github.com/LyraVoid/Shirone-Content.git' },
];

const argv = process.argv.slice(2);
const checkOnly = argv.includes('check');
const doPush = argv.includes('--push');
const picked = repos.filter((r) => argv.includes(r.name));
const targets = picked.length ? picked : repos;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

let failed = 0;

for (const repo of targets) {
  const cwd = path.join(root, repo.dir);
  console.log(`\n=== ${repo.dir}（上游 ${repo.upstream}）===`);

  if (!git(cwd, ['rev-parse', '--git-dir']).ok) {
    console.error('[跳过] 不是 git 仓库');
    failed++;
    continue;
  }

  if (!git(cwd, ['remote', 'get-url', 'upstream']).ok) {
    const add = git(cwd, ['remote', 'add', 'upstream', repo.upstream]);
    if (!add.ok) {
      console.error(`[失败] 添加 upstream remote：${add.err}`);
      failed++;
      continue;
    }
    console.log('[初始化] 已添加 upstream remote');
  }

  const fetch = git(cwd, ['fetch', 'upstream', 'main']);
  if (!fetch.ok) {
    console.error(`[失败] fetch upstream：${fetch.err}`);
    failed++;
    continue;
  }

  const hasMirror = git(cwd, ['rev-parse', '--verify', '--quiet', 'sync-fork']).ok;
  if (checkOnly) {
    const upstreamPending = git(cwd, ['rev-list', '--count', `${hasMirror ? 'sync-fork' : 'upstream/main'}..upstream/main`]).out || '0';
    console.log(`[状态] sync-fork ${hasMirror ? `落后上游 ${upstreamPending} 个提交` : '尚不存在'}`);
    if (hasMirror && upstreamPending === '0') console.log('[状态] sync-fork 已是上游 main 的最新镜像');
    if (hasMirror) {
      const mainBehind = git(cwd, ['rev-list', '--count', 'main..sync-fork']).out || '0';
      const mainAhead = git(cwd, ['rev-list', '--count', 'sync-fork..main']).out || '0';
      console.log(`[状态] main 落后镜像 ${mainBehind} 个提交（待人工审查合并），领先 ${mainAhead} 个提交（本仓定制）`);
      if (mainBehind !== '0') {
        console.log('[提示] 审查待合并内容：git -C ../' + repo.dir + ' log main..sync-fork --oneline');
      }
    }
    continue;
  }

  // git fetch refspec语法的 src:dst 更新本地分支时天然只接受快进，分叉会被拒绝
  const mirror = git(cwd, ['fetch', 'upstream', 'main:sync-fork']);
  if (!mirror.ok) {
    console.error('[失败] sync-fork 与上游 main 分叉（非快进），已拒绝更新。请人工确认镜像分支无独有提交后执行：');
    console.error(`    git -C ../${repo.dir} branch -f sync-fork upstream/main`);
    if (mirror.err) console.error(mirror.err.split('\n').map((l) => '    ' + l).join('\n'));
    failed++;
    continue;
  }
  const created = (mirror.out + mirror.err).includes('new branch');
  console.log(created ? '[完成] 已创建 sync-fork 镜像分支' : '[完成] sync-fork 已快进到上游 main 最新');

  if (doPush) {
    const pushRes = git(cwd, ['push', '-u', 'origin', 'sync-fork']);
    if (!pushRes.ok) {
      console.error(`[失败] 推送 origin sync-fork：${pushRes.err}`);
      failed++;
      continue;
    }
    console.log('[完成] 已推送 origin sync-fork');
  }

  const mainBehind = git(cwd, ['rev-list', '--count', 'main..sync-fork']).out || '0';
  if (mainBehind === '0') {
    console.log('[完成] main 已包含上游全部提交，无需合并');
  } else {
    console.log(`[提示] main 落后镜像 ${mainBehind} 个提交。审查后由人工决定合并：`);
    console.log(`    git -C ../${repo.dir} log main..sync-fork --oneline   # 审查`);
    console.log(`    git -C ../${repo.dir} merge sync-fork                 # 合并进 main（冲突人工解决）`);
  }
}

console.log('');
process.exit(failed ? 1 : 0);
