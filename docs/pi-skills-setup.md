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

两个本项目沉淀的 skill，**真源在全局库**，项目内通过 junction 引用：

| Skill | 真源（唯一） | 项目内形态 |
|---|---|---|
| `perf-hang-triage` | `E:/Obsidian/lic-notebook/skills/perf-hang-triage/` | junction |
| `cf-worker-local-env` | `E:/Obsidian/lic-notebook/skills/cf-worker-local-env/` | junction |

两个都是**通用能力**（页面卡死分层诊断 / Cloudflare Workers 环境约束），
不含本项目硬编码事实，因此放全局库、跨项目复用。

## 重建步骤

### 1. 确认全局库存在这两个 skill

```bash
ls -d E:/Obsidian/lic-notebook/skills/perf-hang-triage \
      E:/Obsidian/lic-notebook/skills/cf-worker-local-env
```

若缺失，从本项目 git 历史恢复（曾提交于 `908e89c` / `116c4eb`）：

```bash
git show 908e89c:.pi/skills/perf-hang-triage/SKILL.md > /tmp/pht.md
git show 908e89c:.pi/skills/cf-worker-local-env/SKILL.md > /tmp/cwle.md
mkdir -p E:/Obsidian/lic-notebook/skills/{perf-hang-triage,cf-worker-local-env}
cp /tmp/pht.md E:/Obsidian/lic-notebook/skills/perf-hang-triage/SKILL.md
cp /tmp/cwle.md E:/Obsidian/lic-notebook/skills/cf-worker-local-env/SKILL.md
```

### 2. 创建 junction（Windows，普通用户权限即可）

```bash
cd <项目根>
mkdir -p .pi/skills

cmd //c "mklink /J .pi\\skills\\perf-hang-triage E:\\Obsidian\\lic-notebook\\skills\\perf-hang-triage"
cmd //c "mklink /J .pi\\skills\\cf-worker-local-env E:\\Obsidian\\lic-notebook\\skills\\cf-worker-local-env"
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

期望输出含：`cf-worker-local-env, perf-hang-triage`（另加 3 个全局 skill）。

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

## 相关记录

- `CONTEXT.md` →「第 10 步复盘（第二次沉淀）」→「六、Skill 存放位置定稿」
- 完整根因报告：`docs/e2e-evidence/focus-hang/ROOT-CAUSE-FINAL.md`
