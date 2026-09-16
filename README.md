# TASCO — 面向 Code Agent 的选择性上下文优化（工具发布仓）

**TASCO**（**T**ask-**A**ware **S**elective **C**ontext **O**ptimization，
任务感知选择性上下文优化）是一个面向 Code Agent 的选择性上下文优化运行时，
目标是在**保证任务成功率、结果正确性和仓库健康度不退化**的前提下，通过任务感知
的选择性介入，降低 Code Agent 执行过程中的输入、输出、缓存 Token 以及不必要的
工具调用和探索轮次。它**不是通用 summarizer**：是否优化、何时优化由证据形态决定，
其余场景**默认保持 Native（原生执行）**。

本仓 = TASCO 的**产品发布仓**（deploy 闭包镜像到 root）。当前发布内容 =
**tasco-v0.8-rc2** 资格化闭包（Release Qualified / Pending Release Approval）：
142 payload / 146 package，由确定性生成器产出，`deploy_manifest.json` 内含全部
文件 SHA256，可离线校验完整性。

## 当前版本：tasco-v0.8-rc2

```text
发布内容
└─ deploy 闭包（142 payload，sourceCommit 34b858e8 构建树）
   Existing-Line Evidence Closure：7/7 evidence lines resolved
   （6 CLOSED + 1 CLOSED-BOUNDED，11 units，registry 948 runs，F0=0）

   默认 AUTO（runner 默认开启）：Diagnostic / Terminal-State /
   Validation Delta / Failure Carrier / Search Guidance（跨仓）/ Read R1-R5
   默认关：Search Result Compression（operator flag）；Structural Context =
   frozen Native by design

历史发布
├─ tasco-v0.7  Validation Coverage Expansion（M-V3 验证语义身份 + Search
│              Compression bridge 集成）
├─ tasco-v0.6  Read R1-R5 任务驱动读取压缩默认 AUTO
└─ tasco-v0.5  Terminal / Validation Delta / Failure Carrier 默认 AUTO + 统一仲裁
```

- **能力证据摘要**：[CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)
- **部署与接入**：[DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)
- **观测与 telemetry**：[RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)

## 能力概览

| Capability | Tier | Default | 场景 |
| --- | --- | --- | --- |
| Diagnostic Semantic Compression（Large Diagnostic） | AUTO | ON | ≥4K 大型诊断价值输出（error-path 诊断、compiler/stack 输出）；`exit=0` 研究对象（`exit!=0` 归 Failure Carrier） |
| Failure Carrier → Diagnostic | AUTO | ON | 真实测试/构建失败（`exit!=0`）自动进入诊断压缩链；原命令/exit code/输出全程保留 |
| Terminal-State Success Compression | AUTO | ON | `exit=0` 且完整可识别的成功 test/build 终态 |
| Validation Delta Compression | AUTO | ON | 同一验证重复执行且可比较：只交付"发生了什么变化"（M-V3 语义身份，FP=0） |
| 统一仲裁 | 冻结 | 常驻 | 一次输出只选一种内容变换：失败诊断 > 稳定 VD > 成功终态 > Native；`double_apply_count` 恒为 0 |
| 精准代码搜索（Search Guidance） | AUTO（跨仓泛化） | ON | DISCOVERY/FILTER 意图正区自动注入搜索收敛引导；LOOKUP/枚举/统计/未知保持 Native |
| Read R1-R5（Read Core + Read Extended） | AUTO | ON | 任务驱动读取压缩：R1 抽取 / R2 关系边 / R3 实现链 / R4 重读抑制 / R5 文档节选；R2/R3 需 identity map（on-demand 生产） |
| Search Result Compression | 独立开关 | **OFF**（operator flag） | 筛选型 grep 结果压缩（bridge grep 腿）；分布/计数/枚举 fail-closed；`CODE_GUARD_STRUCTURED_SEARCH=1` 显式启用 |
| Structural Context | frozen Native | — | 设计性 Native；探索削减边界证据 |

> 家族口径：前四行任务输出能力 = **一个 Task Output Compression 家族下的 4 种
> 互斥策略**（一次工具输出至多一次内容变换）。全部能力归纳为
> **3 大类 / 6 家族 / 7 条证据线路**（任务输出 4 + Read 2 + Search 1）。

# 安装

## 环境要求

- Git
- Node.js >= 18（实测 24）
- 任一受支持 Agent CLI：Claude Code >= 2.1.x、CodeAgentCLI 3.0（Claude 兼容，
  `.cac` 配置）或 OpenCode V1——三者通过统一 Agent Adapter 消费同一套冻结核心
- 兼容 Anthropic 协议的模型端点。当前 Qualification 使用
  `deepseek-v4-flash`；其他模型或端点需重新执行 Qualification。

## 克隆并固定版本

```bash
git clone https://github.com/sunSUNQ/TASCO.git tasco
cd tasco
git checkout tasco-v0.8-rc2          # 当前发布 tag

# 运行时闭包已随本仓提供；常驻接入时指向 hooks
export CODE_GUARD_HOOK_DIR="$(pwd)/hooks"
```

## 接入 Agent（Claude Code / CodeAgentCLI / OpenCode）

- **Claude Code / CodeAgentCLI**：通过 Agent 的 hooks schema 接线
  （Claude Code → `.claude/settings.json`；CodeAgentCLI → `.cac/settings.json`），
  把 `PreToolUse` / `PostToolUse` / `UserPromptSubmit` 事件接到
  `adapters/claude_bridge.js`。
- **OpenCode**：走插件协议。把 `plugin/governance.js` 复制到项目的
  `.opencode/plugins/`，并确保 `.opencode/package.json` 带 `"type": "module"`；
  插件通过 `CODE_GUARD_DEPLOY_ROOT`（回退 `CODE_GUARD_HOOK_DIR\..`）解析闭包。

一键 runner 覆盖三种 Agent（自动安装/清理接线、实时打印 hook 与
selected/applied telemetry）：

```powershell
# Claude Code
& .\run-tasco-task.ps1 -Agent claude -WorkDir D:\my-project -Prompt "运行 npm test 并分析失败根因，不要修改文件。" -EnableTasco

# CodeAgentCLI 3.0（需要 -Model 或 CODE_GUARD_INTERNAL_MODEL）
& .\run-tasco-task.ps1 -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" -WorkDir D:\my-project -Prompt "..." -EnableTasco

# OpenCode（模型由本机 opencode auth 提供）
& .\run-tasco-task.ps1 -Agent opencode -OpenCodeModel "deepseek/deepseek-v4-flash" -WorkDir D:\my-project -Prompt "..." -EnableTasco
```

六条能力线在标准 runner（`-EnableTasco`）中**默认开启**，如需回滚可显式关闭；
Search Result Compression 默认关，需显式启用：

```powershell
$env:CODE_GUARD_TERMINAL_STATE = "0"                  # 可选：关闭 Terminal-State 压缩
$env:CODE_GUARD_VALIDATION_DELTA = "0"                # 可选：关闭 Validation Delta
$env:CODE_GUARD_FAILURE_CARRIER_AUTO = "0"            # 可选：关闭 Failure Carrier（回到 legacy）
$env:CODE_GUARD_SEARCH_GUIDANCE = "0"                 # 可选：关闭精准代码搜索
$env:CODE_GUARD_SEARCH_GUIDANCE_AUTO = "0"            # 可选：只关闭跨仓泛化（回到白名单模式）
$env:CODE_GUARD_READ_COMPRESSION = "0"                # 可选：Read R1-R5 全 Native
$env:CODE_GUARD_STRUCTURED_SEARCH = "1"               # 可选：启用 Search Result Compression（默认关）
```

## 关键环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `CODE_GUARD_HOOK_DIR` | 冻结核心 hook 目录（pre/post policy hooks、compressor） | 必填 |
| `CODE_GUARD_NODE_BIN` | 运行核心 hook 的 node 可执行文件 | 自动解析 |
| `CODE_GUARD_BASE_DIR` | 状态 / telemetry / 归档根目录 | `<项目>/.code-guard` |
| `CODE_GUARD_AGENT_RUNTIME` | 强制指定 agent 运行时：`opencode` / `claude-code` | 自动检测 |
| `CODE_GUARD_CACHE_DISCOUNT` | 有效成本模拟中的 cache-read 权重 | `0.1` |
| `CODE_GUARD_DEPLOY_ROOT` | OpenCode 插件解析冻结闭包的根目录 | `CODE_GUARD_HOOK_DIR\..` |
| `CODE_GUARD_OPENCODE_CMD` | OpenCode CLI 可执行文件路径 | npm 全局 `opencode.exe` |
| `CODE_GUARD_OPENCODE_MODEL` | OpenCode 使用的 `provider/model` | `deepseek/deepseek-v4-flash` |
| `CODE_GUARD_TERMINAL_STATE` | Terminal-State 成功终态压缩 | runner 默认 `1`；显式 `0` 回滚 |
| `CODE_GUARD_VALIDATION_DELTA` | Validation Delta 重复验证增量 | runner 默认 `1`；显式 `0` 回滚 |
| `CODE_GUARD_FAILURE_CARRIER_AUTO` | 失败自动进诊断链（Auto Failure Carrier） | runner 默认 `1`；显式 `0` 回滚 |
| `CODE_GUARD_SEARCH_GUIDANCE` | 精准代码搜索（搜索过程自动收敛引导） | runner 默认 `1`；显式 `0` 回滚 |
| `CODE_GUARD_SEARCH_GUIDANCE_AUTO` | 跨仓泛化模式（仓库白名单不再参与 eligibility） | runner 默认 `1`；显式 `0` 回到白名单模式 |
| `CODE_GUARD_SEARCH_GUIDANCE_PILOTS` | 试点仓白名单（仅未开 AUTO 时生效） | `fastify`（兼容保留） |
| `CODE_GUARD_READ_COMPRESSION` | Read R1-R5 读取压缩（R2/R3 另需 identity map） | runner 默认 `1`；显式 `0` 全 Native |
| `CODE_GUARD_STRUCTURED_SEARCH` | Search Result Compression（bridge grep 腿） | 默认关；显式 `1` 启用（operator flag） |

## 完整性校验

```powershell
# deploy_manifest.json 内含 142 个 payload 文件的 SHA256；可用任意工具逐文件核对
# （powerShell 示例见 DEPLOYMENT-GUIDE.zh-CN.md）
```

# 原理概述

Code Agent 会在工具输出上消耗大量上下文。朴素的修复——「全都压缩」——是失败的：
实验证明，盲目压缩带来的局部 token 节省，会被验证性重读（verification
re-read）和轨迹扰动部分甚至全部吃掉。TASCO 的核心结论是：**优化收益高度依赖
证据形态**——按证据形态分为 Content Reduction（压缩已产生的内容）与 Exploration
Reduction（减少为寻找信息而产生的上下文）。

一次工具事件的高层流程：

```text
agent 事件（PreToolUse / PostToolUse / UserPromptSubmit；OpenCode: before/after）
        |
        v
统一 Agent Adapter（agent 检测 -> 工具名归一化 -> 载荷归一化）
        |
        v
Capability Selector（保守、显式规则驱动；默认 Native）
        |
        v
Quality Guard -> Primitive Executor -> fallback（fail-open）
        |
        v
结果适配 + telemetry（selected / applied / fallback_reason）
```

路由采用**保守、显式规则驱动**的策略：以确定性规则路由为主，不依赖额外模型进行
能力选择；未知意图、编辑意图、lexical 精确性要求、负区 / 边界条件、低置信度场景
一律保持 Native。

# 实验证据（摘要）

指标口径：**LCR** = `(rtIO + 0.1 * cacheRead)`_启用 / `(rtIO + 0.1 * cacheRead)`_Native
（<1 = 净收益）；**TSR** = turns_启用 / turns_Native（质量优先）；安全底线 =
WIR / wrong_capability / double_apply / F0 全部为 0。

证据宇宙：registry 948 runs（eligible 652）、7/7 evidence lines resolved、
安全宇宙 F0=0。

| 能力 | 关键数据（冻结口径） | 状态 |
| --- | --- | --- |
| Large Diagnostic | 36/36 controlled（3 仓），tasco 18/18 applied + model-visible；macro median saving 91.9%（IQR 79.6-93.0）；safety 4/4 | CLOSED |
| Failure Carrier | 36/36 controlled；macro median 82.6%（47.5-91.9）；single execution；safety 5/5；wrong_capability=0 | CLOSED |
| Terminal-State | Lab 43/43（96.09% pooled）+ A/B 18/18 + Online 3752 chars model-visible | CLOSED |
| Validation Delta | Online unchanged 6299→130；M-V3 语义身份 FP=0；自然工作流 repeat 机会 1/6（opportunity-limited，诚实边界） | CLOSED-BOUNDED |
| Search Guidance | 30/30：tasco 注入 12/12、native 0/12、task_success 24/24；safety 2/2 零误注入 | CLOSED |
| Search Result Compression | 24/24 controlled；15 次 compressed greps macro median 92.7%（IQR 80.5-96.2）；default-off fail-closed | CLOSED（default OFF） |
| Read R1-R5 | R4 suppress median 96.5% / R3 94.5% / R5 58.7%；R2 15/15；R4 safety 24/24 零 wrong_suppression | CLOSED ×5 |
| Structural Context | G1 静态资格门不可满足证明；结构替代 LCR 0.74 | frozen Native |

逐能力试验细节见 [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)。

## 冒烟与验收

```powershell
# 离线冒烟（无模型、零依赖，几秒出结果）
cd examples\terminal-state-compression-smoke;  npm run smoke       # Terminal-State
cd examples\arbitration-one-winner-smoke;      npm run smoke       # 统一仲裁
cd examples\validation-delta-smoke;            npm run smoke       # Validation Delta
cd examples\failure-carrier-smoke;             npm run smoke       # Failure Carrier
cd examples\diagnostic-compression-smoke;      npm run diagnostic  # Large Diagnostic
cd examples\read-compression-smoke;            npm run smoke       # Read R1-R5
cd examples\precision-search-smoke;            npm run smoke       # 精准代码搜索
cd examples\session-marker-smoke;              npm run smoke       # 会话标记
```

端到端验收流程见 [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)。

# Roadmap

- [x] v0.5：Terminal / Validation Delta / Failure Carrier 默认 AUTO + 统一仲裁冻结
- [x] v0.6：Read R1-R5 任务驱动读取压缩默认 AUTO
- [x] v0.7：Validation Coverage Expansion（M-V3 语义身份 + Search Compression 集成）
- [x] v0.8-rc2：Existing-Line 7/7 收口 + Release Qualification（manifest 闭包修复）→ **Release Qualified / Pending Release Approval**
- [ ] GA 审批 → tag `tasco-v0.8`
- [ ] 1.0 能力扩展（研发线）：Diff/Patch → Git State/History → Dependency → Test/Build Structured → Trajectory Delta；北极星 = Task Compression Coverage@5% ≥ 80%

# License

[MIT](./LICENSE) — Copyright (c) 2026 sunSUNQ (TASCO contributors)

# 引用

如果你在研究中使用了 TASCO，请引用本仓库（论文发表后会在本节补充正式条目）：

```bibtex
@misc{tasco2026,
  title        = {{TASCO}: Selective Context Optimization for Code Agents},
  author       = {TASCO contributors},
  year         = {2026},
  howpublished = {\url{https://github.com/sunSUNQ/TASCO}},
  note         = {v0.8-rc2: 7/7 existing capability lines closed and frozen (large diagnostic, failure carrier, terminal state, validation delta, search guidance + compression, read R1-R5) under one frozen arbitration contract}
}
```
