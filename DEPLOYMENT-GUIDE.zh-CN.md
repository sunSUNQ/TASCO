# TASCO v0.7 部署指南

面向接收 TASCO v0.7 交付包的使用者。本仓库根目录就是完整部署包：运行时、文档、运维脚本与冒烟示例全部内置。**不需要**研发仓、实验 fixture，也不需要 `npm install`。

- 产品总览、目录结构与各包作用 → [README.md](./README.md)
- runner 参数、观测脚本输出解读、错误代码与能力边界 → [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)
- 已开启能力的试验佐证、其余能力验证进度 → [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)

TASCO 只在已验证正区介入；Shell、Search、Read 的正区与负区总表见 [README.md](./README.md)。未知场景默认保持 Native（原生执行）。

## 1. 新机最低要求

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| Windows | Windows 10/11 或等价 Server | 本包按 Windows 交付 |
| Node.js | 18 或更高（推荐 24） | 运行 bridge 与 hook，JS 只用 Node 内置模块 |
| Agent CLI | CodeAgentCLI / Claude Code CLI / OpenCode CLI 任一，已登录 | 本指南示例默认 CodeAgentCLI |

**不需要**：Python、`pip install`、任何环境变量、手动改 Agent 配置——`run-tasco-task.ps1` 会自动完成全部配置（见第 2 节）。Git 与研发仓也不是部署前提。

## 2. 验收流程（部署完就跑这 4 步）

### 第 1 步：放置部署包

把整个 TASCO 仓库复制或克隆到目标机固定位置（本文以 `D:\tasco` 为例；实际放哪都行，只需把后续命令里的路径替换掉）。**不要改动包内文件**，也不要只复制其中某几个子目录。

> **CodeAgentCLI 先授权目录（使用 CodeAgentCLI 的前提）**：runner 在后台非交互启动 CLI，目录授权询问无法弹出，未授权目录会导致任务直接失败。放包后先执行一次：
>
> ```powershell
> cd D:\tasco\examples\diagnostic-compression-smoke
> codeagentcli      # 交互模式启动；出现“允许访问此目录”询问时选允许，然后退出
> ```
>
> 每个新项目目录第一次使用前都要做一次。换 Claude Code（`-Agent claude`）无此步骤。

### 第 2 步：只读预检

```powershell
& D:\tasco\tools\test-tasco-preflight.ps1 `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ"
```

看到 `TASCO preflight PASS` 即通过；错误会带 `TASCO_E_*` 代码与修复建议。

### 第 3 步：跑冒烟测试样例

随包 fixture（`examples\diagnostic-compression-smoke`）会输出一段单一根因（缺失 `PAYMENTS_API_URL`）的模拟故障日志，正好落在 Diagnostic 压缩正区：

```powershell
& D:\tasco\run-tasco-task.ps1 `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Prompt "Run node scripts/emit-diagnostic.js exactly once. Diagnose the root cause of the simulated checkout outage from that output. State the failing component, the missing configuration key, and the safe next step. Do not modify files and do not run tests." `
  -EnableTasco
```

终端实时输出中出现下面一行即表示压缩真实发生：

```text
[tasco] selected=diagnostic_semantic applied=diagnostic_semantic tool=run_shell_command fallback=
```

任务正常结束的标志是 `[tasco] exit=0 ... summary=...\.tasco-runs\<时间戳>\summary.json`。

### 第 3b 步（推荐）：六条能力线离线冒烟

随包自带六个**离线、零依赖、无模型**的确定性冒烟，直接驱动真实 runtime 验证六条
能力主线（不需要 API/授权，几秒出结果）：

```powershell
cd D:\tasco\examples\terminal-state-compression-smoke;  npm run smoke   # ① 成功结果压缩
cd D:\tasco\examples\arbitration-one-winner-smoke;      npm run smoke   # ② 多能力自动选择
cd D:\tasco\examples\validation-delta-smoke;            npm run smoke   # ③ 重复验证只报变化
cd D:\tasco\examples\failure-carrier-smoke;             npm run smoke   # ④ 失败自动进诊断链
cd D:\tasco\examples\precision-search-smoke;            npm run smoke   # ⑤ 精准代码搜索
cd D:\tasco\examples\read-compression-smoke;            npm run smoke   # ⑥ 任务驱动 Read 压缩
```

| 冒烟 | 验证内容 | 通过标志 |
| --- | --- | --- |
| ① terminal-state | 成功终态只保留关键结果（counts/summary 保留，逐 case PASS 省略） | `SMOKE PASS`，交付含 `[TERMINAL_STATE_SUCCESS]` |
| ② arbitration | 多能力同时满足只选一种（失败诊断 > 稳定 VD > 成功终态 > Native），`double_apply=0` | `SMOKE PASS`，三向冲突格 `winner=validation_delta` |
| ③ validation-delta | 同一验证重复执行只交付"发生了什么变化"（`success_unchanged` / `counts_changed`） | `SMOKE PASS`，delta `mode=success_unchanged` |
| ④ failure-carrier | 真实失败自动包装进诊断链（原命令/真实 exit code/单次执行保留），成功命令透传、unsafe 不改写 | `SMOKE PASS`，`delivered diag` 为压缩摘要 |
| ⑤ precision-search | 搜索过程自动收敛（DISCOVERY/FILTER 跨仓意图门控），LOOKUP/枚举/统计零注入，回滚干净 | `SMOKE PASS`，`negative cells injected: 0/4` |
| ⑥ read-compression | 读取按任务派生策略压缩：R1 目标符号提取、R2 map 关系边、R4 重复抑制 + refresh、R5 章节提取；R0 与 flag OFF → Native | `SMOKE PASS`，交付含 `[EXTRACTIVE READ v1]` / `[READ_SUPPRESSED]` / `[READ_RELATION_EVIDENCE]` / `[READ_SECTION_EXTRACTION]` |

六线合起来：**失败时只看根因，第一次成功只看结果，重复验证只看变化，搜索时自动
缩小范围，读取时只看任务要的部分、重复的不重发；多种机会同时出现时系统自动只选
一种，不确定时保持原始结果。** 逐项断言
与证据位置见
[examples/README.md](./examples/README.md) 与各目录内 README。

### 第 4 步：用两个观测脚本读取结果

```powershell
# 最近一次 session 结论（重点看「效果」一行是否为 POSITIVE）
& D:\tasco\tools\get-latest-tasco-session.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke

# 全部历史 session + 正负效果汇总
& D:\tasco\tools\get-tasco-session-history.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke
```

**怎么算验收完成**：

| 检查项 | 通过标准 |
| --- | --- |
| 预检 | `TASCO preflight PASS` |
| 冒烟任务 | exit=0，agent 答出 `component: payments-client / missing key: PAYMENTS_API_URL` |
| 压缩发生 | 实时日志出现 `applied=diagnostic_semantic` |
| 六线离线冒烟（第 3b 步） | 六个 `npm run smoke` 全部 `SMOKE PASS` |
| 观测脚本 | `get-latest` 显示 `效果: POSITIVE`；`get-history` 汇总 `sessions=1 positive=1` |

> 冒烟期间某次调用出现 `applied=native fallback=...` 是**正常保护行为**（该输出不满足压缩资格就保持原生），不算失败。观测脚本参数与输出逐行解读见 [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)。

## 3. 日常使用：两种接入方式

| 方式 | 适合 | telemetry 位置 | 需要环境变量 |
| --- | --- | --- | --- |
| **A. runner（推荐先验收）**：`run-tasco-task.ps1 -EnableTasco` 跑单个任务 | 跑任务/测试、按次观测 | `<项目>\.tasco-runs\<run>\` | **无**（自动配置） |
| **B. 常驻 hooks**：把 hook 写进 Agent settings | 日常随手用 Agent | `<项目>\.code-guard\` | `CODE_GUARD_HOOK_DIR`（唯一必需） |

方式 A 临时注入 hook 配置，跑完自动清理，**不覆盖**你已有的 settings 文件。方式 B 见下节。

## 4. 常驻接入（可选，日常使用推荐）

### 4.1 环境变量（方式 B 唯一需要设置的一个）

```powershell
$env:CODE_GUARD_HOOK_DIR = "D:\tasco\hooks"   # 指向本包 hooks/（压缩执行器）
# 持久生效用：[Environment]::SetEnvironmentVariable("CODE_GUARD_HOOK_DIR", "D:\tasco\hooks", "User")
```

没有它 bridge 找不到压缩执行器，会 fail-open 保持原生（不报错、不阻断）。其余变量全部有自动默认，见第 5 节。

### 4.2 把 hook 写进 Agent settings

**CodeAgentCLI** 读项目根 `.cac\settings.json`；**Claude Code** 读 `.claude\settings.json`（同构 schema，仅目录名不同）。二选一，不要两个都配。内容：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node D:\\tasco\\adapters\\claude_bridge.js" }] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node D:\\tasco\\adapters\\claude_bridge.js" }] }
    ]
  }
}
```

保存后新开终端验证：跑一个产生大诊断输出的任务，然后在 `<项目>\.code-guard\hook_invoked.jsonl` 看到调用记录即接线成功。

> 全局（所有项目生效）：把同样的内容放到用户级 `C:\Users\<你>\.claude\settings.json`（CodeAgentCLI 为 `\.cac\`）。已有 `settings.local.json` 的项目不要用 runner 再跑（runner 拒绝覆盖已有本地配置）。
> **OpenCode** 不走 hooks schema：把 `plugin\governance.js` 复制到项目 `.opencode\plugins\`，再设 `CODE_GUARD_DEPLOY_ROOT=D:\tasco` 即可；runner 的 `-Agent opencode` 会自动完成。

## 5. 环境变量参考（默认都不需要设置）

方式 A（runner）自动设置全部运行所需变量；方式 B（常驻）只需第 4.1 节一个。下表按「什么时候才需要动它」排序，避免被无关项干扰：

| 变量 | 何时需要 | 说明 |
| --- | --- | --- |
| `CODE_GUARD_HOOK_DIR` | 常驻接线**必需** | 指向本包 `hooks/` |
| `CODE_GUARD_AGENT_RUNTIME` | 基本不用 | 自动检测 `claude-code` / `opencode` |
| `CODE_GUARD_BASE_DIR` | 想改状态/归档位置时 | 默认 `<项目>\.code-guard`；runner 模式自动用 run 目录 |
| `CODE_GUARD_CODEAGENT_CMD` / `CODE_GUARD_CLAUDE_CMD` / `CODE_GUARD_OPENCODE_CMD` | CLI 不在 PATH 时 | Agent 可执行文件绝对路径 |
| `CODE_GUARD_INTERNAL_MODEL` | 常驻 codeagent 不想每次传模型名 | 同 `-Model` 的作用 |
| `CODE_GUARD_OPENCODE_MODEL` | OpenCode 换模型 | 默认 `deepseek/deepseek-v4-flash` |
| `CODE_GUARD_RLM_ENABLED` / `GEMINI_HOOK_PYTHON` / `RLM_*` | **不需要** | 历史 RLM 压缩路径变量；默认体验（Diagnostic）走本地压缩，不依赖 Python/RLM |

## 6. 卸载

删除 Agent settings 里的两条 hook 配置（或删除 `.cac\settings.json` / `.claude\settings.json` 中对应条目），移除 User 级 `CODE_GUARD_HOOK_DIR`，再删掉 `D:\tasco` 即可完全恢复原生行为。telemetry 目录（`.tasco-runs\` / `.code-guard\`）确认不再需要后自行删除。

## 7. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| 报 `TASCO_E_MODEL_REQUIRED` | codeagent 必须带 `-Model "DeepSeek-v4-Flash-SZ"`（或设 `CODE_GUARD_INTERNAL_MODEL`）。 |
| 任务一开始就失败，或日志提示需要目录授权/允许访问 | CodeAgentCLI 未对该目录授权：先按「验收流程 第 1 步」后的说明，在该目录交互启动一次 `codeagentcli` 并允许访问。 |
| 报 `TASCO_E_AGENT_NOT_FOUND` | Agent CLI 不在 PATH：传 `-CodeAgentCommand <exe路径>`（或对应 `-*Command`）。 |
| 观测脚本报 `TASCO_E_RUNS_ROOT_NOT_FOUND` | 还没跑过任务或 `-Path` 指错；先跑一次 `run-tasco-task.ps1 -EnableTasco`。 |
| 一直 Native（没有压缩） | 输出是否够大、是否只读单根因诊断？小输出/编辑/枚举类任务 Native 是预期行为，不是故障。 |
| PowerShell 禁止运行脚本 | 用 `powershell -NoProfile -ExecutionPolicy Bypass -File 脚本路径` 执行。 |
| CLI/模型返回鉴权或配额错误 | 检查 Agent CLI 自身登录与模型名（组织网关），不是 TASCO 问题。 |

## 8. 能力边界

v0.7 默认启用 Shell 的失败诊断、成功终态、重复验证与统一仲裁，以及 Search Discovery/Filter 引导和任务驱动 Read 压缩。每条能力的正区与 Native 边界见 [README.md](./README.md#当前能力边界按工具类型)。

未命中已验证规则的输出一律 Native（fail-open：任何异常都回退原生，不阻断 Agent）。压缩能力无外部 API 依赖：压缩模型由 Agent 内部路由，部署方无需配置第三方端点。完整性校验：`deploy_manifest.json` 记录全部 **124** 个 payload 文件 SHA256，目标机可离线校验包是否被改动。
