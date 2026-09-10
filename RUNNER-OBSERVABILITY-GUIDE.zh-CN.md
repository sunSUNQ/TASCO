# TASCO v0.7：运行与观测指南

本文说明如何**跑一个 TASCO 任务**、**读取压缩结论**与**定位配置问题**，不改变任何压缩策略。当前版本为 `tasco-v0.7`；Shell、Search 与 Read 的能力边界见 [README.md](./README.md)。默认行为仍是 Native：未命中正区不是失败。

- 安装、环境要求、日常常驻接线与卸载 → [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)
- 产品总览与目录结构 → [README.md](./README.md)
- 已开启能力的试验佐证、其余能力验证进度 → [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)

## 冒烟验收（新机推荐顺序）

拿到 TASCO 部署包后，先跑一遍下面 4 步，确认压缩链路真实可用。**不需要安装 Python、不需要设置任何环境变量、不需要手动接线**——runner 会自动完成全部配置。

前置条件：
1. Node.js 18+；
2. Agent CLI 已登录（本指南默认示例为 CodeAgentCLI + 显式模型；换 Claude Code / OpenCode 见下文「Agent 与模型参数」）；
3. **CodeAgentCLI 需先授权目标目录**：首次使用某目录前，在该目录内交互启动一次 `codeagentcli` 并允许“访问此目录”（runner 后台启动 CLI，授权询问无法弹出；详见 [README.md](./README.md)「使用前提」）。

```powershell
# 1) 只读预检：检查本机依赖（错误带 TASCO_E_* 代码与修复建议）
& D:\tasco\tools\test-tasco-preflight.ps1 `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ"

# 2) 冒烟：让 Agent 分析一段模拟故障日志（零依赖确定性 fixture）
& D:\tasco\run-tasco-task.ps1 `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Prompt "Run node scripts/emit-diagnostic.js exactly once. Diagnose the root cause of the simulated checkout outage from that output. State the failing component, the missing configuration key, and the safe next step. Do not modify files and do not run tests." `
  -EnableTasco

# 3) 读最近一次 session 结论
& D:\tasco\tools\get-latest-tasco-session.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke

# 4) 读全部历史汇总（多跑几次后看正负效果）
& D:\tasco\tools\get-tasco-session-history.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke
```

跑第 2 步时，终端实时输出的关键行：

```text
[tasco] selected=diagnostic_semantic applied=diagnostic_semantic tool=run_shell_command fallback=
[tasco] exit=0 turns=3 summary=...\.tasco-runs\<时间戳>\summary.json
```

怎么算成功（3 个都要满足）：

| 检查 | 通过标准 |
| --- | --- |
| 任务 | runner 退出码 0，agent 答出 `component: payments-client / missing key: PAYMENTS_API_URL` |
| 压缩发生 | 实时日志出现一次 `applied=diagnostic_semantic`；若某次调用显示 `applied=native fallback=...` 属正常（该输出不满足资格，保持原生） |
| 结论 | 第 3 步输出 `效果: POSITIVE`，且 `net_saved_tokens_est > 0` |
| 六线离线冒烟（推荐） | `examples\` 六个能力目录 `npm run smoke` 全部 `SMOKE PASS`（见下） |

### 六条能力线离线冒烟（推荐，无需模型）

随包自带四个离线确定性冒烟（几秒出结果，不需要 API/授权）：

```powershell
cd D:\tasco\examples\terminal-state-compression-smoke;  npm run smoke   # ① 成功结果压缩
cd D:\tasco\examples\arbitration-one-winner-smoke;      npm run smoke   # ② 多能力自动选择
cd D:\tasco\examples\validation-delta-smoke;            npm run smoke   # ③ 重复验证只报变化
cd D:\tasco\examples\failure-carrier-smoke;             npm run smoke   # ④ 失败自动进诊断链
cd D:\tasco\examples\precision-search-smoke;            npm run smoke   # ⑤ 精准代码搜索
cd D:\tasco\examples\read-compression-smoke;             npm run smoke   # ⑥ 任务驱动 Read 压缩
```

六个全部 `SMOKE PASS` 即六条默认能力链路真实可用；逐项断言与期望输出见
[examples/README.md](./examples/README.md) 与各目录内 README。


### Agent 与模型参数

| 场景 | runner / preflight 参数 | 说明 |
| --- | --- | --- |
| **CodeAgentCLI（本指南示例默认）** | `-Agent codeagent -Model "DeepSeek-v4-Flash-SZ"` | 模型名**必须显式提供**（`-Model` 或环境变量 `CODE_GUARD_INTERNAL_MODEL`），否则报 `TASCO_E_MODEL_REQUIRED`。CLI 自动发现：`CODE_GUARD_CODEAGENT_CMD` → `CODE_GUARD_CLAUDE_CMD` → `codeagentcli`（PATH）。 |
| Claude Code | `-Agent claude -Model deepseek-v4-flash` | 也可省略两个参数——代码默认即 `claude` + `deepseek-v4-flash`。CLI 自动发现 npm 全局安装。 |
| OpenCode | `-Agent opencode -OpenCodeModel "deepseek/deepseek-v4-flash"` | 模型名用 `provider/model` 格式，由 opencode 自身 auth 提供。 |

注意：preflight 用统一的 `-AgentCommand` 指定 CLI 绝对路径；runner 对应为 `-CodeAgentCommand` / `-ClaudeCommand` / `-OpenCodeCommand`（CLI 不在 PATH 时才需要）。三份指南示例统一默认 CodeAgentCLI；你的目标机若是其它 Agent，把上表对应参数替换进第 1、2 步命令即可。

## run-tasco-task.ps1 参数

| 参数 | 必填 | 默认 | 含义 |
| --- | --- | --- | --- |
| `-Prompt` | **是** | — | 交给 Agent 的任务文本。验收/压测建议只读、单根因诊断任务。 |
| `-Agent` | 否* | `claude` | `claude` / `codeagent` / `opencode`。*CodeAgentCLI 场景**建议显式传 `codeagent`**（本文示例默认）；代码默认仍是 `claude`。 |
| `-Model` | 否* | `CODE_GUARD_CLAUDE_MODEL` → `deepseek-v4-flash` | Claude/CodeAgent 模型名。*`-Agent codeagent` 时**必须传**（或用 `CODE_GUARD_INTERNAL_MODEL`），否则报 `TASCO_E_MODEL_REQUIRED`。 |
| `-WorkDir` | 否 | 当前目录 | 目标项目根目录。 |
| `-EnableTasco` | 否 | 关 | 加上才接入 TASCO hooks；省略即原生对照。 |
| `-CodeAgentCommand` / `-ClaudeCommand` / `-OpenCodeCommand` | 否 | 对应环境变量或自动发现 | CLI 不在 PATH 时传绝对路径；只传当前 `-Agent` 对应的一个。 |
| `-OpenCodeModel` | 否 | `deepseek/deepseek-v4-flash` | 仅 OpenCode。 |
| `-TascoVersion` | 否 | `tasco-v0.7` | 仅写入 telemetry 的版本标签，不切换任何代码。通常不要设置。 |
| `-PollMilliseconds` | 否 | `750` | 实时输出刷新间隔。通常保持默认。 |

运行产物：`<项目>\.tasco-runs\<时间戳>\`（先看 `summary.json`，含 run 结论 + 内嵌压缩结论）。

## 用户观测脚本

数据都在 `<项目>\.tasco-runs\` 下。两个观测脚本**只读**结果文件，不改动任何数据；找不到数据只报错并给建议。`-Path` 接受项目目录 / `.tasco-runs` / 具体 run 三层任意一层（默认当前目录）。PowerShell 禁止脚本时用 `powershell -NoProfile -ExecutionPolicy Bypass -File 脚本路径`。

| 想看什么 | 用哪个 |
| --- | --- |
| 最近一次跑得怎么样（压没压、省多少、结论正负） | `get-latest-tasco-session.ps1` |
| 全部历史逐次结论 + 正负汇总 | `get-tasco-session-history.ps1`（`-Limit N` 只看最近 N 个） |

两个脚本都支持 `-AsJson` 输出结构化字段，方便脚本二次处理。典型输出（`get-latest`）与逐行含义：

```text
TASCO 最近 session
Run/Session : 20260903-164031 / 9f5c1740-...
任务        : type=DIAGNOSTIC source=router_telemetry status=SUCCESS exit=0 turns=3
TASCO       : enabled=True observed=True selected=1 applied=1 fallback=0
压缩        : 30,000 -> 7,449 chars, gross=22,551, recovery=0, net=22,551, rate=75.17%
Token 节省  : gross=5619 recovery=0 net=5619 mode=estimated_from_telemetry
效果        : POSITIVE (task_success_and_positive_net_saving)
```

- `selected` = 判定可压缩的次数；`applied` = 实际执行压缩的次数；`fallback` = 判定后放弃回退原生次数。
- `rate 75.17%` 为字符压缩率；`Token 节省` 按约 4 字符 ≈ 1 token **估算**，不是计费口径。
- `效果` 判定：`POSITIVE` = 任务成功 + 有压缩 + 净节省为正 + 无回退；`NEGATIVE` = 净节省为负；`NEUTRAL` = 未介入或零收益；`NEEDS_REVIEW` = 任务失败 / 信息不全 / 有回退，不能直接归因。

常见报错（都是「找不到数据/参数问题」，不是脚本坏了）：

| 报错 | 含义 | 处理 |
| --- | --- | --- |
| `TASCO_E_RUNS_ROOT_NOT_FOUND` | 目录下没有 `.tasco-runs` | 先跑一次 `run-tasco-task.ps1 -EnableTasco`，或把 `-Path` 指到跑过任务的项目。 |
| `TASCO_E_NO_SESSIONS` | 有 `.tasco-runs` 但没有完成的 run | 任务结束后再查。 |
| `TASCO_E_SUMMARY_NOT_FOUND` | 最近 run 还没有 summary.json | 任务可能仍在运行。 |
| `TASCO_E_MODEL_REQUIRED` | codeagent 没给模型名 | 加 `-Model "DeepSeek-v4-Flash-SZ"`。 |

高级工具（保留给实时观察与旧自动化）：`watch-tasco-session.ps1 -RunDir <run目录> -Follow` 实时 follow；`summarize-tasco-sessions.ps1 -RunsRoot <...>` 基础汇总。

## 错误分类与处理

| 现象 | 分类 | 处理 |
| --- | --- | --- |
| `TASCO_E_WORKDIR_NOT_FOUND` | 参数 | 修正 `-WorkDir`。 |
| `TASCO_E_AGENT_NOT_FOUND` | 本机环境 | 传对应 `-*Command` 绝对路径，或修正 `CODE_GUARD_*_CMD`。 |
| `TASCO_E_NODE_NOT_FOUND` | 本机依赖 | 安装 Node.js 18+，重开终端。 |
| `TASCO_E_DEPLOY_INCOMPLETE` | 部署 | 使用完整 TASCO 部署包，不要单独复制脚本。 |
| CLI / 模型返回鉴权、配额、网络错误 | 模型/服务 | 不是 TASCO 参数问题；检查 Agent CLI 登录、模型名、网关。细节在 `<run>\claude.stderr.log`。 |
| Hook 在但始终 Native | 预期边界 | 小输出、编辑、精确文本、枚举类任务 Native 是设计行为，不要为提高触发率调整策略。 |

## 能力边界（哪些会压缩、哪些保持 Native）

`-EnableTasco` 只表示接入 hooks，不代表所有输出都会被压缩。v0.7 的 Shell、Search 和 Read 默认能力与 Native 边界如下：

| 能力 | 状态 | 自动压缩的任务 | 保持 Native 的任务 | 回滚开关 |
| --- | --- | --- | --- | --- |
| Diagnostic Semantic Compression | **AUTO（默认开）** | 高容量、低决策密度的单根因诊断输出 | 编辑、精确原文/断言恢复、全量枚举、多源归因、小输出 | — |
| Failure Carrier → Diagnostic（④） | **AUTO（runner 默认）** | 真实测试/构建失败（`exit!=0`、test/build 命令形态）；原命令/exit code/stdout/stderr 保留 | 非 test/build 形态、shell 元字符、watch/交互、malformed carrier → legacy | `CODE_GUARD_FAILURE_CARRIER_AUTO=0` |
| Terminal-State Success Compression（①） | **AUTO（runner 默认）** | `exit=0` + 完整 test/build summary + 未截断 | 失败、unknown、截断、普通 shell、不完整 reporter | `CODE_GUARD_TERMINAL_STATE=0` |
| Validation Delta（③） | **AUTO（runner 默认）** | 同命令可比较的重复验证，只交付变化（含失败基线下的 resolution 模式） | 无 comparable previous、不可比 fingerprint | `CODE_GUARD_VALIDATION_DELTA=0` |
| 精准代码搜索（⑤，Line-5） | **AUTO（runner 默认）** | DISCOVERY/FILTER 意图正区（调用链入口、wrapper→实现、依赖定位、symbol 消歧）跨仓注入搜索收敛引导 | LOOKUP（找定义）、枚举、统计、未知意图 → Native | `CODE_GUARD_SEARCH_GUIDANCE=0`（全关）/ `CODE_GUARD_SEARCH_GUIDANCE_AUTO=0`（回到白名单模式） |
| 任务驱动 Read 压缩（⑥，Line-6） | **AUTO（runner 默认）** | 任务派生的读取：R1 目标符号提取（95%+）、R2 调用关系边、R3 实现链、R4 重复读抑制、R5 章节提取；全部 model-visible | 无法分类（R0）、无任务符号/map、无净节省、非入口文件读取、小读取 → Native | `CODE_GUARD_READ_COMPRESSION=0`（读全 Native）/ `CODE_GUARD_READ_MAP_AUTOBUILD=0`（关闭 map 按需生成，缺 map 仓 R2/R3 → Native） |
| Structural / Search Result | Native / Shadow | —（边界已冻结，未达默认开启门槛） | 一切默认原生 | — |

统一仲裁（冻结 precedence）：**失败诊断 > 稳定 Validation Delta > 成功终态 > Native**
——一次输出只有一个 winner，`double_apply_count` 恒为 0；失败语义只看
`original_exit_code`（Failure Carrier 契约），与 wrapper 进程 exit=0 严格分离。
不要用环境变量强行扩大未达门槛的能力——默认 Native 与显式回滚是安全设计的一部分。
