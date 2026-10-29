# pi Skills 本地配置（重建说明）

> 本文件说明**本项目专属的 pi Skill 配置如何在新机器/克隆后重建**。
> `.pi/skills/` 已加入 `.gitignore`，因为它是本机 AI 工具配置，且包含 git 无法表达的链接语义。

## 为什么 `.pi/skills/` 不进 git

两个原因：

1. **git 无法表达 Windows junction 语义**。本项目用 `mklink /J` 创建目录联接，
   但 `core.symlinks=false`（Windows 默认）时 git 会把 junction 当真实目录、跟随进去存**文件副本**。
   克隆后链接关系丢失，退化成会漂移的独立副本。
2. **它是本机工具配置，不是项目源码**。谁用 pi 谁自己配，不该强迫所有克隆者接受。

## 当前配置

五个本项目沉淀的 skill，**真源在全局库**，项目内通过 junction 引用：

| Skill | 真源（唯一） | 项目内形态 |
|---|---|---|
| `perf-hang-triage` | `E:/Obsidian/lic-notebook/skills/perf-hang-triage/` | junction |
| `cf-worker-local-env` | `E:/Obsidian/lic-notebook/skills/cf-worker-local-env/` | junction |
| `workers-ai-model-usage` | `E:/Obsidian/lic-notebook/skills/workers-ai-model-usage/` | junction |
| `rag-retrieval-tuning` | `E:/Obsidian/lic-notebook/skills/rag-retrieval-tuning/` | junction |
| `ci-parity-triage` | `E:/Obsidian/lic-notebook/skills/ci-parity-triage/` | junction |

四个都是**通用能力**（页面卡死分层诊断 / Cloudflare Workers 环境约束 / Workers AI 模型调用 /
RAG 检索调优），不含本项目硬编码事实，因此放全局库、跨项目复用。

> 2026-10-28 新增 `workers-ai-model-usage` / `rag-retrieval-tuning`：来自产品③ kb-ask 二期的线上实测
> （视觉模型入参形状矩阵与 5016 许可自愈、混合检索两道闸门与多轮锚点链稀释、四指标评测标定）。
> 2026-10-29 新增 `ci-parity-triage`：仓库首次接 GitHub Actions，5 个 job 逐个红灯暴露的 6 类环境差异
> （依赖锁定 / 文件存在性 / 大小写 / locale 排序 / 网络绑定 / env 文件）。见下方「新增 skill 的沉淀流程」。

## 重建步骤

### 1. 确认全局库存在这两个 skill

```bash
ls -d E:/Obsidian/lic-notebook/skills/perf-hang-triage \
      E:/Obsidian/lic-notebook/skills/cf-worker-local-env \
      E:/Obsidian/lic-notebook/skills/workers-ai-model-usage \
      E:/Obsidian/lic-notebook/skills/rag-retrieval-tuning       E:/Obsidian/lic-notebook/skills/ci-parity-triage
```

若缺失，从本项目 git 历史恢复（曾提交于 `908e89c` / `116c4eb`）：

```bash
git show 908e89c:.pi/skills/perf-hang-triage/SKILL.md > /tmp/pht.md
git show 908e89c:.pi/skills/cf-worker-local-env/SKILL.md > /tmp/cwle.md
mkdir -p E:/Obsidian/lic-notebook/skills/{perf-hang-triage,cf-worker-local-env}
cp /tmp/pht.md E:/Obsidian/lic-notebook/skills/perf-hang-triage/SKILL.md
cp /tmp/cwle.md E:/Obsidian/lic-notebook/skills/cf-worker-local-env/SKILL.md
```

> ⚠️ 后三个 skill（2026-10-28/29 新增）的真源**只存在于全局库**（Obsidian 仓库），
> 本项目 git 历史里没有副本。全局库丢失 = 这两个 skill 丢失，备份好 `E:/Obsidian/lic-notebook`。

### 2. 创建 junction（Windows，普通用户权限即可）

```bash
cd <项目根>
mkdir -p .pi/skills

cmd //c "mklink /J .pi\\skills\\perf-hang-triage E:\\Obsidian\\lic-notebook\\skills\\perf-hang-triage"
cmd //c "mklink /J .pi\\skills\\cf-worker-local-env E:\\Obsidian\\lic-notebook\\skills\\cf-worker-local-env"
cmd //c "mklink /J .pi\\skills\\workers-ai-model-usage E:\\Obsidian\\lic-notebook\\skills\\workers-ai-model-usage"
cmd //c "mklink /J .pi\\skills\\rag-retrieval-tuning E:\\Obsidian\\lic-notebook\\skills\\rag-retrieval-tuning"
```

> ⚠️ **不要用 `ln -s`**：Git Bash 的 `ln -s` 在无权限时会**静默降级成复制**，
> 看起来成功实则生成独立副本（本项目踩过此坑）。用 `MSYS=winsymlinks:nativestrict` 会直接报
> `Operation not permitted`。**`mklink /J`（junction）普通用户可用，`mklink /D`（符号链接）需要管理员或开发者模式。**

### 3. 写入项目信任记录

`.pi/skills` 是**受项目信任保护资源**（见 pi `docs/security.md`）。
非交互模式（`pi -p`）在无信任记录时**静默跳过**，表现为「文件放了但 skill 不生效」。

```bash
node -e '
const fs=require("fs");
const cwd=fs.realpathSync("<项目根绝对路径>");
const p="C:/Users/<用户名>/.pi/agent/trust.json";
let d={}; if(fs.existsSync(p)) d=JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,""));
d[cwd]=true; fs.writeFileSync(p, JSON.stringify(d,null,2));
'
```

或交互模式下首次进入项目时选「Trust」。

### 4. 验证

```bash
pi -p "列出你当前可用的所有 skill 名称，逗号分隔，只输出名称。"
```

期望输出含：`cf-worker-local-env, perf-hang-triage, workers-ai-model-usage, rag-retrieval-tuning, ci-parity-triage`（另加全局 skill）。

验证链接是否真生效（改动真源应立刻反映）：

```bash
echo "marker" >> E:/Obsidian/lic-notebook/skills/perf-hang-triage/SKILL.md
tail -1 .pi/skills/perf-hang-triage/SKILL.md   # 应看到 marker
sed -i '$ d' E:/Obsidian/lic-notebook/skills/perf-hang-triage/SKILL.md   # 回滚
```

## 全局配置不要全量加载

`~/.pi/agent/settings.json` **不要**加 `skills` 指向整个 `E:/Obsidian/lic-notebook/skills` 目录。

踩过的坑：那样会让 23 个 skill 在**每个项目、每个会话**都加载，
description 合计约 11,700 字符 ≈ **3,900 tokens 固定成本**。

正确做法：需要时用 `/skill:name` 或 `pi --skill <path>` 显式加载。

## 新增 skill 的沉淀流程（2026-10-28 定稿）

产品③ 二期结束后把线上实战经验沉淀成全局 skill，流程固定为：

1. **按全局库 `skills/README.md` 第二节的收纳判定表裁决归属**：
   - 环境/工具专属坑 → 独立通用技能
   - 同一规则在 ≥2 处维护 → 抽 `_shared/`（本次无）
   - 只被一个流程用 → 留在编排器内联（本次无）
2. **正文只写「验收标准写死 + 踩过的坑写活」**，代码里能读出来的不写。
3. **体量红线**：单文件 SKILL.md ≤500 行（README 建议）—— 超了把细节拆 `references/`，
   主文件只留入口与速览。`cf-worker-local-env` 本次由 589 行拆到 476 行。
4. **补触发口**：`口令对照表.md` 加一行（项目技能除外）。
5. **跑引用完整性校验**（提交前必跑）：
   ```bash
   node E:/Obsidian/lic-notebook/skills/check-refs.mjs
   ```
   校验四项：引用图无环 / 无断链 / 触发口齐全 / 无明文凭证。
   **校验器本身要验证过**：故意注入一个环 + 一个断链 + 一条明文凭证，确认都能被抓到
   （本次已验证——第一版校验器的环检测因节点命名不一致而漏检，已修）。
6. **项目侧建 junction** 并更新本文件的「当前配置」表。

## 相关记录

- `CONTEXT.md` →「第 10 步复盘（第二次沉淀）」→「六、Skill 存放位置定稿」
- 完整根因报告：`product1/docs/e2e-evidence/focus-hang/ROOT-CAUSE-FINAL.md`
