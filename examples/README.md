# TASCO Examples — 能力主线冒烟索引

每个 example 都是**离线确定性、零依赖、无模型**的冒烟：直接驱动真实 frozen
runtime（bridge / policy hook / carrier shim），证据落在各自 `.tasco-runs/` 下。
运行方式：进入目录后 `npm run smoke`（或 `node scripts/run_smoke.js`）。

| 顺序 | 主线 | 解决的问题 | Example | 预期结果 |
| --- | --- | --- | --- | --- |
| ① | P0 成功结果压缩 | 测试/构建成功后，只保留关键结果 | `terminal-state-compression-smoke` | `[TERMINAL_STATE_SUCCESS]` 提取式压缩，counts/summary 保留 |
| ② | A0/A1 多能力自动选择 | 多种压缩能力同时满足时，只选一种、不冲突 | `arbitration-one-winner-smoke` | 每次输出恰好一个 winner；失败诊断 > 稳定 VD > 成功终态 > Native |
| ③ | M3 重复验证结果压缩 | 同一验证重复执行，只告诉模型"发生了什么变化" | `validation-delta-smoke` | `[VALIDATION_DELTA]` success_unchanged / counts_changed；无 previous → Native |
| ④ | P1 失败诊断自动处理 | 真实测试/构建失败自动进入诊断压缩链 | `failure-carrier-smoke` | PreToolUse 自动包装 → 失败 carrier → Diagnostic 压缩交付；单次执行 |
| ⑤ | 精准代码搜索 | 搜索时自动缩小范围、定位关键候选（DISCOVERY/FILTER 意图跨仓） | `precision-search-smoke` | 意图正区注入收敛引导；负区（LOOKUP/枚举/统计）FP=0；跨仓一致；回滚干净 |
| ⑥ | 任务驱动 Read 压缩 | Agent 读取按任务目的压缩：目标符号/关系边/重复抑制/章节提取 | `read-compression-smoke` | R1 提取 / R2 map 边 / R4 重复抑制 + refresh / R5 章节；R0 与 flag OFF → Native |
| ◆ | 看板对接最小 kit | 打点管线联调：一次最小真实压缩 + start/end 打点，实时打印看板行 | `session-marker-smoke` | session_end 行含 compression 效果（saved_chars 仅计 model-visible）；对接方用它验证 NDJSON tail / HTTP POST 链路 |

一句话介绍（对应六条线）：

> **失败时只看根因，第一次成功只看结果，重复验证只看变化，搜索时自动缩小范围，
> 读取时只看任务要的部分、重复的不重发；多种机会同时出现时系统自动只选一种，
> 不确定时保持原始结果。**

## 与产品开关的对应

| 线路 | 运行时开关 | 标准会话默认 |
| --- | --- | --- |
| ① Terminal-State | `CODE_GUARD_TERMINAL_STATE` | AUTO（显式 `0` 回滚） |
| ② Arbitration | 常驻（AUTO-ARBITRATION-V1） | AUTO |
| ③ Validation Delta | `CODE_GUARD_VALIDATION_DELTA` | AUTO |
| ④ Failure Carrier | `CODE_GUARD_FAILURE_CARRIER_AUTO` | AUTO（显式 `0` 回滚 M3-era legacy） |
| ⑤ 精准代码搜索 | `CODE_GUARD_SEARCH_GUIDANCE`（跨仓泛化：`CODE_GUARD_SEARCH_GUIDANCE_AUTO`） | AUTO（显式 `0` 全关；`AUTO=0` 回白名单模式） |
| ⑥ 任务驱动 Read | `CODE_GUARD_READ_COMPRESSION` | AUTO（显式 `0` 回滚；R2/R3 另需 identity map，无 map → Native） |

回滚任一开关 = 该能力回到 Native/legacy；各线互相独立，一次输出仍只会有一个
winner（②的冻结 precedence 保证）。
