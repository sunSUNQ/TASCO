# TASCO v1.0.2：能力试验佐证

本文说明：**当前默认开启的能力线凭什么发布**，以及**其余能力做过什么试验、
为什么保持关闭**。数据来自研发线冻结收口（Existing-Line Evidence Closure：
7/7 evidence lines resolved，registry 948 runs，F0=0）；本包为结论摘要。

## 0. v0.8-rc2 收口摘要（B1–B4 战役冻结口径）

| 能力线 | 关键数据（冻结口径） | 状态 |
| --- | --- | --- |
| Large Diagnostic | 36/36 controlled（3 仓 3/3/3），tasco 18/18 applied + model-visible；macro median saving 91.9%（IQR 79.6–93.0，range 71.8–94.6）；safety 4/4；oracle echo 不对称已文档 | CLOSED |
| Failure Carrier | 36/36 controlled；macro median 82.6%（47.5–91.9）；single execution；safety 5/5 reject 全对；wrong_capability=0 | CLOSED |
| Terminal-State | Lab 43/43（96.09% pooled）+ A/B 18/18 + Online 3,752 chars model-visible；冲突 suite 按冻结 precedence 让位 failure diagnostic / stable VD | CLOSED |
| Validation Delta | Online unchanged 6,299→130、failure→success resolution 可达；M-V3 语义身份 FP=0；自然工作流 repeat 机会 1/6（opportunity-limited，诚实边界，非能力失败） | CLOSED-BOUNDED |
| Search Guidance | 30/30（含 sd1 anchor）：tasco 注入 12/12、native 0/12、task_success 24/24；safety 2/2 零误注入 | CLOSED |
| Search Result Compression | 24/24 controlled，tasco 压缩命中 9/12（3 collapse = 设计内 native）；15 次 compressed greps macro median 92.7%（IQR 80.5–96.2）；default-off 4/4 fail-closed | CLOSED（default OFF） |
| Read R1–R5 | R4 suppress median 96.5%（27 次交付）/ R3 94.5% / R5 58.7%；R2 关系边 15/15；R4 safety 24/24 零 wrong_suppression；tinyhttp 机会域边界定格（R2/R3 map 依赖） | CLOSED ×5 |
| Structural Context | G1 静态资格门不可满足证明；所有场景 Native passthrough；Type-B 重复中等证据的结构替代 LCR 0.74 | frozen Native |

## 1. 指标速读

| 指标 | 含义 |
| --- | --- |
| success `N/N vs N/N` | 不压缩 N 个任务全对、压缩后 N 个也全对 = **压缩没让任务变差** |
| LCR（性价比） | 压缩花的成本 ÷ 省下的收益。**<1 才划算**：0.550 = 花 0.55 买到 1，净赚 45% |
| WIR（闯祸次数） | 压缩改错信息导致 Agent 走错路的次数。**0 = 一次没闯祸**，安全底线 |
| wrong_capability / double_apply | 压错能力 / 同一输出重复交付的次数。**恒为 0**（统一仲裁 + 单次交付） |
| model-visible delivery | 压缩结果**真实到达模型上下文**（stream tool_result 验证），不是 hook 侧自记账 |
| 正区 / 负区 | 适合压缩的场景 / 绝不能压的场景；拿不准的一律 Native |

## 2. 四条任务输出主线（默认 AUTO）的定级试验依据（v0.5 时期冻结，历史记录）

一句话：**失败时只看根因，第一次成功只看结果，重复验证只看变化；多种机会同时
出现时系统自动只选一种，不确定时保持原始结果。**

### ① Terminal-State 成功结果压缩

| 试验 | 结果 |
| --- | --- |
| Lab 保留合同 | 43/43 PASS；5 fixture pooled 96.09%（64,164→2,507 chars） |
| 真实 Agent A/B（18 cell） | success 9/9 vs 9/9；exposure 9/9 格各恰 1 次 applied；0 recovery |
| Online Qualification | 默认路径真实触发；显式 `0` 回滚保持 Native |
| v0.5 Online BC cell | 首次成功 → Terminal 交付 3,752 chars（model-visible）；Diagnostic 干涉 0 |

### ② 多能力统一仲裁（一次输出一个 winner）

| 试验 | 结果 |
| --- | --- |
| A1 仲裁 Runtime | 冻结 precedence（失败诊断 > 稳定 VD > 成功终态 > Native）；冲突集成 PASS |
| Transport 修复 | hook applied ≠ model consumed 缺陷修复；三在线 run model-visible 全 verified |
| v0.5 S3 冲突套件 | 10/10：三向冲突 → VD 唯一胜出；失败 carrier 压过 Terminal；malformed → Native；`expected winner 100%`、`double_apply=0` |

### ③ Validation Delta 重复验证压缩

| 试验 | 结果 |
| --- | --- |
| Lab（M3） | 契约/单测/桥接/冲突/全量 deploy 回归 PASS；三模式 primitive |
| Online Qualification | 真实 runner：unchanged 8,908→130 chars，model-visible（`[VALIDATION_DELTA]` 真实 stream 可见） |
| v0.5 Online | BC cell 重复成功 6,299→130 chars；failure→success resolution 模式经 Failure Carrier 在线首次可达（237 chars） |
| 回归 | flag OFF 逐字节回滚（无 delta、无 fingerprint 状态文件） |
| v0.8 补强 | M-V3 语义身份（cd-compound 等价重验识别）FP=0；B4 自然机会资格化：1/6 两段式工作流形成 repeat，decline 于 evidence gate 为设计内 fail-closed → honest CLOSED-BOUNDED |

### ④ Failure Carrier 失败诊断自动处理（P1）

| 试验 | 结果 |
| --- | --- |
| 平台探针（S0） | PreToolUse updatedInput 对 Bash 生效（10/10）；失败命令无 PostToolUse → 失败入口 = exit-0 carrier（A2 7/7） |
| Carrier Contract（S1） | schema/硬约束/消费规则冻结；A2→Diagnostic E2E 10/10（7,654→891，根因保留） |
| Carrier-Aware Eligibility（S2a） | 4 种 prompt 措辞同 eligibility；malformed/exit=0/缺字段 → Native；C1–C10 10/10 |
| Auto Carrier（S2b） | F1–F8 8/8：真实失败 → 改写 → 恰一次执行 → carrier → Diagnostic；single execution（side-effect 对账）；success 透传、unsafe 不改写 |
| Online Runner | 真实失败 7,478→681 chars（model-visible、root cause 保留、agent 修复正确）；single execution；wrong_capability=0 |
| v0.8 收口（B1-c） | 36/36 controlled（3 仓 3/3/3）；macro median 82.6%；safety 5/5 边界 reject 全对 |

### ⑤ Large Diagnostic 大型诊断压缩（v0.8 升格默认 AUTO）

| 试验 | 结果 |
| --- | --- |
| B2-a 批次 | 36/36 controlled（3 仓 3/3/3）：tasco 18/18 applied + emitted + model-visible；native 18/18 显式 capability_disabled raw |
| Macro saving | median 91.9%（IQR 79.6–93.0，range 71.8–94.6） |
| 安全边界 | smalloput/capoff/carrieroff 零压缩行；persistence wall 实证位于 25,000B–43KB → band 上限 25,000 |
| 归因 | F0=0；oracle echo 不对称（native 原始窗口噪声主导）已文档，direction consistent |

## 3. Read / Search 两族（v0.6–v0.8 逐步默认化）

| 能力线 | 定级试验 |
| --- | --- |
| Read R1–R5（v0.6 默认 AUTO） | 五子策略 primitive qualification 全 PASS；R1–R5 各自 A/B 正区 + 3×3 stability；B2 批次收口：R2 15/15 / R3 36/36 / R4 78/78（suppress 27 次 median 96.5%）/ R5 78/78（median 58.7%）；tinyhttp 机会域边界定格（R2/R3 map 依赖，诚实排除） |
| Search Guidance（v0.5–v0.7 默认 AUTO） | S1 历史正区复核 15/15、负区 FP=0；S2 跨仓 eligibility；S4 跨仓在线 express search 7→1 / turns 57→24；B3-a 收口 30/30（tasco 注入 12/12、native 0/12）；safety 2/2 零误注入 |
| Search Result Compression（默认关，operator flag） | S-G lab LCR 0.92–0.95；B3-b 收口：bridge grep 腿集成（flag-gated fail-closed delivered<raw）+ 24/24 controlled（tasco 9/12 命中 + 3 collapse 设计内 native）+ macro median 92.7%；分布/计数负区 sg2/sg3 LCR 1.29–2.62 → default-off fail-closed 部署 |

## 4. 其余能力的当前状态

| 能力 | 状态 | 依据 |
| --- | --- | --- |
| 结构关系地图（Structural Context） | frozen Native by design | G1 静态资格门不可满足证明（SC2-A vs SC2-D 同签名）；历史 A/B/C 正区结论保留（LCR 0.74 于 Type-B） |
| 预读优化 / 复核检测 | 维持 OFF | 真实仓收口 NO-GO / 自然机会近乎 0（历史 L1/L2 资产） |

## 5. 回滚与后续

所有默认 AUTO 能力线均可用环境变量显式回滚（`CODE_GUARD_TERMINAL_STATE` /
`CODE_GUARD_VALIDATION_DELTA` / `CODE_GUARD_FAILURE_CARRIER_AUTO` /
`CODE_GUARD_SEARCH_GUIDANCE` / `CODE_GUARD_READ_COMPRESSION` = `0`），
回滚只影响该能力，仲裁保证其余链路不受影响；Search Result Compression 默认关，
`CODE_GUARD_STRUCTURED_SEARCH=1` 显式启用。离线验证入口见
[examples/README.md](./examples/README.md)。

后续路线（研发线）：E1 Holdout 泛化验证（frozen RC2，预注册纪律）→ 论文增强
实验（RQ4 / M-V4）→ 1.0 能力扩展（Diff/Patch → Git State/History → Dependency
→ Test/Build Structured → Trajectory Delta），北极星 = Task Compression
Coverage@5% ≥ 80%（16 任务族自然 Prompt benchmark）。
