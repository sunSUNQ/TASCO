# TASCO v0.7：能力试验佐证

本文说明 v0.7 当前默认能力的发布依据，以及未默认开启能力为何保持 Native / Shadow。
总览按 Shell / Search / Read 分类见 [README.md](./README.md)；历史 `v0.5` 数据保留为证据，不代表当前发布版本。

## 0. 指标速读

| 指标 | 含义 |
| --- | --- |
| success `30/30 vs 30/30` | 不压缩 30 个任务全对、压缩后 30 个也全对 = **压缩没让任务变差** |
| LCR（性价比） | 压缩花的成本 ÷ 省下的收益。**<1 才划算**：0.550 = 花 0.55 买到 1，净赚 45% |
| WIR（闯祸次数） | 压缩改错信息导致 Agent 走错路的次数。**0 = 一次没闯祸**，安全底线 |
| wrong_capability / double_apply | 压错能力 / 同一输出重复交付的次数。**恒为 0**（统一仲裁 + 单次交付） |
| model-visible delivery | 压缩结果**真实到达模型上下文**（stream tool_result 验证），不是 hook 侧自记账 |
| 正区 / 负区 | 适合压缩的场景 / 绝不能压的场景；拿不准的一律 Native |

## 1. Shell 能力线（默认 AUTO）的试验依据

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

### ④ Failure Carrier 失败诊断自动处理（P1）

| 试验 | 结果 |
| --- | --- |
| 平台探针（S0） | PreToolUse updatedInput 对 Bash 生效（10/10）；失败命令无 PostToolUse → 失败入口 = exit-0 carrier（A2 7/7） |
| Carrier Contract（S1） | schema/硬约束/消费规则冻结；A2→Diagnostic E2E 10/10（7,654→891，根因保留） |
| Carrier-Aware Eligibility（S2a） | 4 种 prompt 措辞同 eligibility；malformed/exit=0/缺字段 → Native；C1–C10 10/10 |
| Auto Carrier（S2b） | F1–F8 8/8：真实失败 → 改写 → 恰一次执行 → carrier → Diagnostic；single execution（side-effect 对账）；success 透传、unsafe 不改写 |
| Online Runner | 真实失败 7,478→681 chars（model-visible、root cause 保留、agent 修复正确）；single execution；wrong_capability=0 |
| M3 保护 | 首次成功 Terminal / 重复成功 VD 链路不被破坏（Online BC 14/14） |

### ⑤ 精准代码搜索（Search Discovery Guidance 泛化，Line-5）

| 试验 | 结果 |
| --- | --- |
| 历史 pilot | Fastify DISCOVERY v2（FD2 turns −40% / tokens −36%）；sd5b 3+3 复现（turns −15% / tokens −17% / search −50%）；LOOKUP 负区 canary emission=0 |
| S1 历史正区复核 | 当前 runtime 下正区 15/15 发射、负区 16/16 抑制（FP=0）、wrong_intent=0 |
| S2 跨仓 eligibility | 仓库白名单移除（`CODE_GUARD_SEARCH_GUIDANCE_AUTO`）；同 prompt 四仓发射逐字节一致；pilot 模式向后兼容 |
| S3 安全 Gate | 负区 FP=0、wrong_strategy=0（确定性 corpus 冻结为回归）、suppressed 零注入 |
| S4 跨仓在线 | express_src（DISCOVERY）：search 7→1、reads 13→10、turns 57→24、结论正确；sg4 消歧（FILTER）2 对：searches/reads 双降、结论正确；Native 对照臂零 guidance |
| S5 Default-On | runner 注入 cell PASS；显式 `0` 全关 cell PASS |

### ⑥ 任务驱动 Read 压缩（Line-6）

| 已验证正区 | 保持 Native 的负区 |
| --- | --- |
| R1 目标符号提取、R2 调用关系边、R3 实现链、R4 未变化内容重复读、R5 文档章节提取 | R0 无法分类、缺 task symbol/map、非入口文件、小读取、无净节省；内容变化时必须 refresh |

离线 smoke 直接驱动真实 runtime，验证交付 model-visible；R4 的安全合同是“宁可重发，也绝不抑制 stale 内容”。

## 2. 其余能力：做了什么、为什么暂不开启

它们都做过真试验，共同卡点是**系统还无法自动可靠地认出"这次该不该管"**，默认不介入是保护而非否定。

| 能力 | 想做什么 | 试验结果 | 卡点 |
| --- | --- | --- | --- |
| 搜索结果压缩 | 对 search 输出本身做结果级压缩 | lab 筛选型 LCR 0.92–0.95 稳定 | 与搜索过程引导分属两层，按单变量纪律独立 qualification（Line-7 候选）；产品层历史 Opportunity 0/10 |
| 结构关系地图 | 把模块依赖图直接给 Agent，省去跨文件翻找 | SC2-A/B/C 3×3 全正向 | 高扇出/弱信息任务反向；Router 历史正例覆盖 0/3（v4 资格门未过） |
| 预读优化 | 编辑前只读必要局部 + 直接帮手函数 | VP1/VP3 原始动作级正向 | 真实仓收口 NO-GO：放宽后 0/3 通过、补救 6 次里 5 次（OFF） |
| 复核检测 | 认出"紧邻重复读同一文件"并提示 | 检测精度验证通过 | 真实场景机会近乎 0（L1 规则资产） |

## 3. 后续路径

按"正区 → 自动开、负区 → 不碰、拿不准 → 不碰"逐子场景补齐资格后再默认开启。
v0.7 各默认能力均可独立回滚（`CODE_GUARD_TERMINAL_STATE` /
`CODE_GUARD_VALIDATION_DELTA` / `CODE_GUARD_FAILURE_CARRIER_AUTO` /
`CODE_GUARD_SEARCH_GUIDANCE` / `CODE_GUARD_READ_COMPRESSION` = `0`），
回滚只影响该能力，仲裁保证其余链路不受影响。离线验证入口见
[examples/README.md](./examples/README.md)；完整证据链见研发仓
`CURRENT_STATUS.md`、`docs/architecture/`（契约）与 `docs/experiments/`（报告）。
