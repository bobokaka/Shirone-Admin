# Shirone-Admin

Shirone 双仓博客的可视化内容管理工具（本地单机，前后端分离）。

## 架构

```
client/   Vue3 + Vite + Element Plus SPA（静态产物，可独立托管）
server/   Fastify REST API（本地直读写内容仓，适配层预留公网形态）
shared/   API DTO 类型
```

- 写入目标：`../Shirone-Content`（唯一事实源），发布 = git commit + push 复用现有部署管线
- 校验与预览复用主题仓：`sync --dry-run`（等价 content:validate）、`content:watch` + `astro dev`
- 二期公网形态：换 Storage/Git 适配器实现 + nginx `/api` 反代，业务代码不动

## 快速开始

```powershell
pnpm install
copy .env.example .env   # 可选，默认按相对路径解析两仓
pnpm dev                 # 同时起动 server(:5175) 与 client(:5173)
```

浏览器打开 http://localhost:5173 。

## 约定

- 文章：`content/posts/<slug>/index.md`，配图 `content/posts/<slug>/images/`
- 说说：`content/moments/*.md`，图片必须 `public/images/moments/<批次>/`（主题缩略图管线只扫此目录）
- 派生资源只读：`public/assets/moments/thumbnails/`、`public/assets/anime/covers/`、字体子集
- 提交信息由发布流自动生成：`type(scope): 中文 ≤30 字`，无 AI 署名
