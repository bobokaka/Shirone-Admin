# CLAUDE.md

本文件约束 Shirone-Admin（工作区第三个仓：博客内容可视化管理工具）的开发。上层 `../CLAUDE.md` 同样适用。

## 仓库定位

本地单机、前后端分离的内容管理工具。**唯一文件写入目标是 `../Shirone-Content`**；`../Shirone` 主题仓不做文件写入（只读供校验与预览），但发布页对其执行 **git 提交与推送**（主题仓被跟踪的 `src/content/`、`public/` 同步产物随行提交，由主题仓自身 CI 把关）。此仓未来公网化时只换适配器实现与部署方式，业务代码不动。

## 命令（Windows，PowerShell，.cmd 后缀）

```powershell
pnpm.cmd install
pnpm.cmd dev            # server(:5175) + client(:5173) 并行
pnpm.cmd dev:server
pnpm.cmd dev:client
pnpm.cmd type-check     # 全 workspace tsc --noEmit
pnpm.cmd build          # client 产物在 client/dist（静态，可交 nginx 托管）
```

## 硬性规则

1. **只写内容仓**：所有文件操作经 `server/src/adapters/storage.ts`，任何路径必须先 resolve 并校验在 `CONTENT_DIR` 子目录内（防目录穿越）。绝不写 `src/content/`（那是主题仓同步产物）。
2. **派生资源只读**：`public/assets/moments/thumbnails/**`、`public/assets/anime/covers/**`、`src/assets/fonts/.subset/**` 是构建期生成物，禁止写入或删除。
3. **说说图必须进 `public/images/moments/`**：主题缩略图管线（`Shirone/scripts/images/generate-moment-thumbnails.mjs`）只扫此目录（支持子目录）；说说 md 同目录放图不会生成缩略图。
4. **frontmatter 序列化保格式**：`published` 必须输出 YAML 裸时间戳 `YYYY-MM-DD`（不可加引号、不可 ISO 化），否则主题 zod `z.date()` 校验失败；`publishedAt` 用 `YYYY-MM-DDTHH:mm:ss+08:00`。`publishedAt` 的 Asia/Shanghai 日历日期必须与 `published` 一致（保存与发布前双重校验）。
5. **自动提交信息**：`type(scope): 中文描述`，≤30 字（如 `feat(content): 新增文章「…」`、`feat(moments): 发布动态`），严禁任何 AI 署名尾注。发布前先跑 `sync --dry-run`（cwd=主题仓，env 带 CONTENT_DIR），失败必须阻止 push（仅内容仓校验；主题仓发布不跑本地校验）。两仓提交信息同格式；主题仓 scope 词汇开放（core/content/cli/docs 等），默认 core。
6. **编辑器只做源码模式**：主题有私有 Markdown 扩展（三冒号容器、file-tree、代码标签页、field 卡片等），禁止引入 WYSIWYG 转换；扩展语法以「插入片段」工具栏提供。
7. 路径分隔符注意：storage 层统一 `node:path`，API 层传相对路径用 `/`；slug 建议 ASCII（pinyin-pro 转写），允许用户显式覆盖但表单需提示中文 slug 的编码风险。
8. **不访问任何在线图标**：Iconify 图标数据全部来自内置 `@iconify-json/*` 依赖（material-symbols、fa6-brands、simple-icons），在 `client/src/utils/icons.ts` 启动时 `addCollection` 注册；`DataIcon` 只渲染本地已注册图标（`iconLoaded` 判定），未收录名降级首字母块，禁止运行时请求 api.iconify.design。需新图标前缀时补装对应依赖并在该文件注册。
9. **常规正文文字不小于 20px**：client 内一切常规正文内容（列表条目、表格单元格、描述项、输入与文本域、提示/说明/空态文案、对话框正文、diff 与日志输出等）字号不得小于 20px。基座在 `client/src/styles.css`（`--el-font-size-base: 20px` + Element Plus 硬编码字号面的定点覆盖），新增界面必须沿用；仅纯辅助微件（tag 徽标、计数角标、代码行号、图标尺寸）可用小字号。

## 技术栈约束

- client：Vue 3 组合式 API + `<script setup>` + TS；Element Plus 全量引入（本地工具不在乎包体）；编辑器用 md-editor-v3 源码模式
- server：Fastify 5 + TS（tsx 直跑）；zod 校验请求体；simple-git 操作内容仓与主题仓（主题仓仅 git 提交/推送，推分支跟踪的默认远端、绝不推 upstream）；Node `process.loadEnvFile` 读 `.env`，不引 dotenv
- shared：纯类型，无运行时依赖

## 提交规范

与两仓一致：`type(scope): 中文描述` ≤30 字，type 取 feat/fix/test/docs/refactor/chore；严禁 AI 署名尾注。scope 用 `admin` 或 `server`/`client`（如 `feat(server): 说说图片上传接口`）。
