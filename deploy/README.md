# TASCO v0.5 — 选择性上下文压缩

**TASCO**（**T**ool-output **A**daptive **S**elective **C**ontext **O**ptimization）是面向 Code Agent 的**选择性上下文压缩工具**：对**已资格化的高容量、低决策密度诊断输出**做语义压缩，减少送入模型上下文的工具输出；**未命中已验证规则的输出默认保持 Native（原生执行）**。

当前产品版（`tasco-v0.7`）有六条能力主线**默认自动开启**：**Diagnostic Semantic Compression（失败/诊断日志）**、**Terminal-State Success Compression（成功终态）**、**Validation Delta（重复验证只报变化）**、**Failure Carrier（真实失败自动进入诊断链）**、**精准代码搜索（DISCOVERY/FILTER 意图跨仓注入搜索收敛引导）**、**任务驱动 Read 压缩（R1 目标符号提取 / R2 调用关系边 / R3 实现链 / R4 重复读抑制 / R5 章节提取）**——每次输出只会有一个能力生效（冻结仲裁：失败诊断 > 稳定 VD > 成功终态 > Native；read_task_compression 只作用于 read_file 事件，与 shell 域候选天然互斥），且压缩结果经 model-visible 验证真实送达模型。各能力可用环境变量独立回滚（见「能力边界」表），未知/不安全场景一律 Native。

> 本目录（`deploy/`）是**自包含交付包**：整个目录复制到目标机即可部署，不需要研发仓、`npm install` 或 Python。

## 文档怎么读（先看这张表）

| 文档 | 内容 | 什么时候看 |
| --- | --- | --- |
| [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md) | **部署操作手册**：新机要求 → 放包 → CodeAgentCLI 授权 → 验收 4 步 → 常驻接线 → 卸载 → FAQ | 拿到包在新机器上装好并验收，**只读这一份就够** |
| [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md) | 运行与观测：runner 全部参数、观测脚本输出解读、错误代码、能力边界 | 日常跑任务/读结论/排障时查阅 |
| [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md) | 能力试验佐证：已开启能力的发布依据 + 其余能力验证进度 | 想了解“凭什么只开 Diagnostic、其它能力到哪一步了”时查阅 |
| 本文件 | 总览：TASCO 是什么、能力边界、包内结构 | 先了解再动手 |

安装部署请直接进入 **DEPLOYMENT-GUIDE.zh-CN.md**（放包 → 授权 → 4 步验收：预检 → 冒烟 → 两个观测脚本读结果，约 10 分钟完成）。

## 使用前提（重要：CodeAgentCLI 先授权目录）

示例默认 Agent 为 **CodeAgentCLI**。CodeAgentCLI 出于安全会在首次访问一个目录时要求**允许访问该目录**的授权——而 runner 在后台非交互启动 CLI，授权询问无法弹出，**未授权会导致任务直接失败**。因此在跑任何 TASCO 命令前，先在目标目录授权一次：

```powershell
cd D:\tasco\examples\diagnostic-compression-smoke
codeagentcli      # 交互模式启动；出现“允许访问此目录”询问时选允许，然后退出
```

每个新项目目录第一次使用前都要做一次；换用 Claude Code（`-Agent claude`）则无此步骤。完整验收流程见 [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md)。

## 能力边界（哪些会压缩、哪些保持 Native）

| 能力 | 状态 | 自动压缩的任务 | 保持 Native 的任务 |
| --- | --- | --- | --- |
| Diagnostic Semantic Compression | **AUTO（默认开）** | 高容量、低决策密度的单根因测试/构建失败、堆栈、诊断日志 | 编辑、精确原文/断言恢复、全量枚举、多源归因、小输出 |
| Terminal-State Success Compression | **AUTO（默认开）** | `exit=0`、完整 test/build summary、输出未截断 | 失败、unknown、截断、普通 shell、不完整 reporter |
| Validation Delta | **AUTO（默认开）** | 同一验证命令重复执行且可比较：只交付"发生了什么变化" | 无 comparable previous、不可比 fingerprint、失败 current（经 Failure Carrier 有失败基线时在线可达 resolution 模式） |
| Failure Carrier（P1） | **AUTO（默认开）** | 真实测试/构建失败（`exit!=0`）自动包装进诊断链，`original_command` / `original_exit_code` / stdout / stderr 全程保留 | 非 test/build 形态、含 shell 元字符、watch/交互命令、malformed carrier（全部 legacy 执行） |
| 精准代码搜索（Line-5） | **AUTO（默认开）** | DISCOVERY/FILTER 意图正区（调用链入口、wrapper→实现、依赖定位、机制发现、symbol 消歧）跨仓自动注入搜索收敛引导 | LOOKUP（找定义）、枚举、统计、未知意图 → Native（冻结边界） |
| Search Result Compression / Structural / Read | Native / Shadow | —（保留已冻结正区证据与机制） | 一切默认输出原生 |

能力开关（默认全开；显式 `0` 回滚该能力，其余不受影响）：
`CODE_GUARD_TERMINAL_STATE` / `CODE_GUARD_VALIDATION_DELTA` /
`CODE_GUARD_FAILURE_CARRIER_AUTO` / `CODE_GUARD_SEARCH_GUIDANCE`（精准代码搜索；
另可用 `CODE_GUARD_SEARCH_GUIDANCE_AUTO=0` 只关跨仓泛化）。
仲裁规则冻结为：**失败诊断 > 稳定 Validation Delta > 成功终态 > Native**——一次输出只有一个 winner，
`double_apply_count` 恒为 0；多种机会同时出现时由证据（`original_exit_code`、fingerprint 可比性、
终态 classifier）决定 winner，与执行顺序无关。

安全设计：默认 Native；fail-open（任何异常回退原生，不阻断 Agent）；压缩模型由 Agent 内部路由，**无外部 API 凭据配置**。成熟度细节见 [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)「能力边界」，发布依据与试验数据见 [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md)。

## 五条主线冒烟（examples/，离线、无模型）

五个 example 对应五条能力主线，全部**零依赖、离线确定性**——直接驱动真实 frozen
runtime（bridge / policy hook / carrier shim），证据落在各自 `.tasco-runs/<时间戳>/`。
每个目录内 `npm run smoke`（或 `node scripts/run_smoke.js`）即可复跑，逐项 PASS/FAIL。

| # | Example（目录） | 测试内容 | 期望关键输出 |
| --- | --- | --- | --- |
| ① | `examples\terminal-state-compression-smoke` | 成功终态提取式压缩：真实 node:test 成功输出，arm OFF（Native）vs arm ON；counts/skipped/fail 计数与 summary 逐项保留 | `[TERMINAL_STATE_SUCCESS]` + `omitted_case_lines=N` + `# pass/# fail` 保留，交付 < 原文 |
| ② | `examples\arbitration-one-winner-smoke` | 多能力同时满足时只选一种：三向冲突（诊断候选+稳定 VD+成功终态）→ VD 唯一胜出；失败 carrier（`original_exit_code=1`）+ 成功形态正文 → 诊断按冻结 precedence 胜出；malformed → Native | `winner=validation_delta (3-way)`、`winner=diagnostic (failure precedence)`、`winner=none (native)`；`double_apply=0` |
| ③ | `examples\validation-delta-smoke` | 重复验证只报变化：首次成功不伪造 delta；重复成功 `success_unchanged`；计数变化 `success_counts_changed`（`pass 45->50`）；flag OFF 逐字节回滚 | `[VALIDATION_DELTA] mode=success_unchanged`（130 chars）+ `mode=success_counts_changed` + `counts_delta` |
| ④ | `examples\failure-carrier-smoke` | 真实失败自动进入诊断链：PreToolUse 自动改写 → shim 真实执行恰一次 → 失败 carrier（original_command / original_exit_code / stdout / stderr 保留）→ Diagnostic 压缩交付；成功命令透传无 carrier；unsafe 命令不改写 | raw carrier 7xxx chars → 交付约 700 chars（root cause 保留）；`single execution (1 rewrite = 1 shim 执行行)`；`wrong_capability=0` |
| ⑤ | `examples\precision-search-smoke` | 精准代码搜索：DISCOVERY/FILTER 意图正区跨仓注入搜索收敛引导（四仓发射逐字节一致）；负区（LOOKUP/枚举/统计/未知）零注入；pilot 白名单兼容；主开关回滚 | `跨仓一致: yes`；`negative cells injected: 0/4`；全部 PASS |
| ⑥ | `examples\read-compression-smoke` | 任务驱动 Read 压缩：R1 任务派生符号提取（verbatim 保真）；R2 map 关系边；R4 重复读抑制 + 内容变化 refresh；R5 章节提取；R0 与 flag OFF → Native | `[EXTRACTIVE READ v1]`（<原文 40%）+ `[READ_SUPPRESSED]`（note 无代码内容）+ `[READ_RELATION_EVIDENCE]` + `[READ_SECTION_EXTRACTION]`；遥测 model-visible |

```powershell
# 逐个运行（任一目录）
cd D:\tasco\examples\terminal-state-compression-smoke;  npm run smoke
cd D:\tasco\examples\arbitration-one-winner-smoke;      npm run smoke
cd D:\tasco\examples\validation-delta-smoke;            npm run smoke
cd D:\tasco\examples\failure-carrier-smoke;             npm run smoke
cd D:\tasco\examples\precision-search-smoke;            npm run smoke
cd D:\tasco\examples\read-compression-smoke;            npm run smoke
```

六线合起来的一句话：**失败时只看根因，第一次成功只看结果，重复验证只看变化，
搜索时自动缩小范围，读取时只看任务要的部分、重复的不重发；多种机会同时出现时
系统自动只选一种，不确定时保持原始结果。**
索引见 [examples/README.md](./examples/README.md)。

## 目录结构

```text
deploy/
├─ README.md                        # 本说明（总览 + 文档导航）
├─ DEPLOYMENT-GUIDE.zh-CN.md        # 部署操作手册（验收流程、常驻接线、卸载、FAQ）
├─ RUNNER-OBSERVABILITY-GUIDE.zh-CN.md
│                                   # 运行与观测（runner 参数、观测脚本、错误码）
├─ CAPABILITY-EVIDENCE.zh-CN.md     # 能力试验佐证（已开启能力的发布依据与其余能力进度）
├─ deploy_manifest.json             # 部署清单：版本 + 全部 payload 文件 SHA256（离线完整性校验）
├─ run-tasco-task.ps1               # 一键 runner：跑任务 + 自动接入 hooks + 落盘 telemetry
├─ examples\                        # 六条主线冒烟（离线、无模型；见上方冒烟表）
│  ├─ terminal-state-compression-smoke\    # ① 成功结果压缩
│  ├─ arbitration-one-winner-smoke\        # ② 多能力自动选择（一次输出一个 winner）
│  ├─ validation-delta-smoke\              # ③ 重复验证只报变化
│  ├─ failure-carrier-smoke\               # ④ 真实失败自动进入诊断链
│  ├─ precision-search-smoke\              # ⑤ 精准代码搜索（跨仓意图门控引导）
│  └─ read-compression-smoke\              # ⑥ 任务驱动 Read 压缩（R1/R2/R4/R5/R0）
├─ tools\                           # 运维脚本
│  ├─ test-tasco-preflight.ps1      # 运行前只读预检（TASCO_E_* 错误码）
│  ├─ get-latest-tasco-session.ps1  # 读最近一次 session 结论
│  ├─ get-tasco-session-history.ps1 # 读全部历史 + 正负汇总
│  ├─ watch-tasco-session.ps1       # 实时 follow（高级）
│  ├─ summarize-tasco-sessions.ps1  # 基础汇总（兼容旧自动化）
│  └─ structural_map_*.js / frozen_maps\   # Shadow 实验工具（默认不介入）
├─ adapters\                        # Agent 协议接线：claude_bridge.js（Claude/CodeAgentCLI 入口）、
│                                   #   agent_runtime / canonical_tools / unified_payload、
│                                   #   opencode_*.js 插件协议适配
├─ core\                            # 压缩判定（冻结）：compression_policy / context_budget /
│                                   #   fallback / action_recovery / edit_policy / capability_*（Router 判定）
├─ hooks\                           # 压缩执行器（冻结）：post_tool_policy_hook.js 入口 +
│                                   #   guard_core / post_tool / pre_tool / tools / rlm\（本地包）
├─ config\                          # 能力线配置（冻结）：search_guidance_pilot.json
├─ plugin\                          # OpenCode V1 插件（governance.js）
├─ skills\                          # Agent 行为引导（code-guard-workflow）
├─ specs\                           # 契约：instructions\（环境/工作流规则）、agents\（角色）
└─ requirements.txt                 # 历史 RLM 路径的 Python 依赖（默认体验不需要）
```

五层职责：**Skill/Spec** 只做行为引导，**Core** 只做「该不该压缩」判定，**Hook** 只做压缩执行，**Adapter** 只做 Agent 协议接线，**tools/** 只做运维观测。改动冻结目录（`core/`、`hooks/`、`adapters/`、`config/`）会破坏 `deploy_manifest.json` 完整性校验；`examples/` 冒烟 fixture 属于验证辅助，不在 payload 清单内（当前 manifest `tasco-v0.7` 为 123 个 payload 文件、127 个 package 文件 + SHA256，目标机可离线校验）。

## 三层能力结构：specs / skills / hooks

把“包内到底哪些代码在起作用”拆成三层看，就不容易混淆：

| 目录 | 层 | 作用 | 内容 | 生效时机 |
| --- | --- | --- | --- | --- |
| `skills/` | Skill：行为引导 | 告诉 Agent「**怎么做**」：限域读取、证据链、避免冗余探索 | `code-guard-workflow/`：SKILL.md + references（边界/平台兼容/工作流规格）+ resources（分任务类型的方法论）+ templates（报告模板） | 会话开始作为指令载入模型上下文 |
| `specs/` | Spec：任务契约 | 定义「**允许做什么**」的环境规则与角色边界 | `instructions/`（Windows 原生工作流等环境契约 5 份）+ `agents/`（focused-fix / repo-analysis / spec-to-code 子代理角色）+ `opencode.json.example` | 同上 |
| `hooks/` | Hook：压缩执行 | 真正执行「**压缩与输出替换**」 | `post_tool_policy_hook.js`（入口，**冻结勿改**）+ `guard_core/`（状态/日志/路径）+ `post_tool/`（压缩器/归档/摘要/证据）+ `pre_tool/`（前置引导）+ `tools/rlm_tool_compress.py` + `rlm/`（本地模型包） | 每次工具调用前/后（PreToolUse / PostToolUse 事件） |

三层之间有一条硬边界：**Skill/Spec 只改变模型被引导的行为，不参与任何一次压缩判定**；“这该不该压缩”只由 Core 判定、Hook 执行（Adapter 负责把不同 Agent 的事件接进来）。所以：

- 不改 `skills/`、`specs/` 不影响压缩行为与清单校验（只影响引导内容）；
- 改动 `hooks/`、`core/`、`adapters/` 会破坏 `deploy_manifest.json` 完整性校验；
- 当前默认体验（Diagnostic 压缩）只依赖 Hook/Core 链路，Skill/Spec 是随包提供的可选用引导资产——不开它们，压缩照常工作。

## 运行产物

每次 `run-tasco-task.ps1 -EnableTasco` 写到 `<项目>\.tasco-runs\<时间戳>\`：

```text
summary.json                              # 先看这个：run 结论（exit/turns/tokens + 内嵌压缩结论）
claude.stream-json.log / claude.stderr.log
hook_invoked.jsonl                        # 每次 Pre/PostToolUse hook 调用
context_budget\claude_auto_canary.jsonl   # 每次压缩判定事件（selected/applied/fallback）
<session_id>\tasco_metrics\              # session 压缩累计（session_summary.json 等）
```

## 环境变量与配置

**默认零配置**：runner（`run-tasco-task.ps1`）自动注入运行所需全部变量并在结束前清理。只有「常驻接入」（手动把 hook 写进 Agent settings）需要设一个变量：`CODE_GUARD_HOOK_DIR` 指向本包 `hooks/`。完整参考见 [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md) 第 5 节。

## License

本包暂未指定开源许可证；正式发布前请与维护者确认。
