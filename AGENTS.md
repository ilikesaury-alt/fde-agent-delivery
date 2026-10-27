# 项目工作规则（Pi 会话自动加载）

> 本文件是 pi 的项目级上下文文件：凡在本仓库（或子目录）内运行的会话都会加载。规则是硬约束，优先于会话习惯。

## Git 提交规则（最重要）

- **绝不自动提交**：不要在任何任务收尾时自行 `git commit`。
- **只有用户明确说「提交」/「commit」才提交**；提交前先展示将要提交的内容概要。
- 提交信息用中文、约定式前缀（`docs:` / `fix:` / `feat:` / `ci:` / `test:` / `chore:`），正文分「内容/结构/治理」小节，与仓库既有提交风格一致。

## 文档规则

- 路径引用口径：**反引号内路径 = 仓库根相对**（如 `product1/CONTEXT.md`）；**markdown 链接 = 相对路径**。
- 移动/新增文档后必须跑引用校验：`node .github/scripts/check-doc-links.mjs`（0 断链才算过）。
- 文档分层：产品级文档放 `productN/docs/`；仓库根 `docs/` 只放跨产品文档；各产品自包含（CONTEXT/features/HANDOFF/deploy/e2e-evidence）。
- 文档口径必须与 CONTEXT/HANDOFF/部署记录一致；过期数字（测试数/版本号/验收状态）视为缺陷要修正。

## 提交前验证基线

- 两产品：`npm run typecheck` + `npm test` + `npm run build` 全过。
- 文档引用校验 0 断链。
- 暂存区无密钥（`.env` / `.secrets.json` / `dist/` 均被 gitignore；`grep` 明文凭据不得命中）。

## 安全

- 不在对话/文档/提交信息中回显明文密钥。
- 密钥只进 Worker env / gitignore 的本地文件；发现明文泄露风险要主动提醒用户。

## 沙箱环境约束（DSH Windows）

- `vite dev` / workerd 不可 spawn → 本地验证用 Node shim（`e2e/server.mjs` 模式），真启动验证放 CI。
- `npm install` 必须 `--ignore-scripts`；`.npmrc` 已设本地缓存。
- 本地 D1 验证用 `node:sqlite` shim。
- 后台命令用 cmd 语法（Windows cmd.exe）。

## 工作流

- 产品开发走 `dev-task-flow` 9 步；每产品 `CONTEXT.md` 是需求活文档（口径只增不改，决策写「决策记录」）。
- 选题/方案类决策先给候选对比 + 推荐 + 待拍板清单，等用户拍板再继续。
