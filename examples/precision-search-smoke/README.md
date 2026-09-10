# TASCO Precision Search Smoke（主线⑤：精准代码搜索）

**问题**：Agent 在代码仓中寻找调用链入口、真实实现或区分同名 symbol 时，经常先
做宽泛搜索、翻看大量无关结果，消耗上下文与轮次。

**本冒烟验证**（离线、无模型，驱动真实 frozen bridge）：当任务属于已证明的搜索
正区（DISCOVERY / FILTER 意图），自动在规划上下文注入一份**搜索收敛引导**——
只含意图与任务派生关键词（frozen 模板，不给答案、不改 tool_input、不 deny）：

```text
Search guidance:
Task intent: discovery.
Guidance:
1. Prefer exact task-specific identifiers before generic terms.
2. Restrict search scope to the relevant source subtree when ...
3. Prefer one focused search over repeated broad searches.
4. Preserve Native search when the task requires complete enumeration, counts, or distribution.
```

同时验证四条硬边界：

- **跨仓一致**：同一任务在任意仓库名下发射逐字节一致（仓库白名单已从
  eligibility 移除，泛化模式 `CODE_GUARD_SEARCH_GUIDANCE_AUTO=1`）
- **负区 FP=0**：LOOKUP（找定义）、枚举、统计、未知意图**零注入**（冻结边界，
  不给"不要缩窄"的反向提示）
- **pilot 兼容**：未开泛化时白名单照常生效（fastify 发射 / express 跳过）
- **回滚**：主开关关闭 → 零 guidance 活动

## 运行

```powershell
cd deploy\examples\precision-search-smoke
npm run smoke
```

## 期望输出

```text
discovery guidance: 5xx chars (跨仓一致: yes)
negative cells injected: 0/4 (must be 0)
  PASS - 正区 DISCOVERY: 注入 frozen 模板（含意图行，不给答案）
  PASS - 正区 FILTER: symbol 消歧任务注入
  PASS - 跨仓一致: 四个仓库名全部发射（mode=auto）
  PASS - 跨仓一致: 发射文本逐字节一致（仓库不参与 eligibility）
  PASS - 跨仓一致: telemetry 记录各自 repo 名
  PASS - 负区 FP=0: LOOKUP（找定义）零注入
  PASS - 负区 FP=0: 枚举/统计/未知 全部零注入
  PASS - pilot 兼容: fastify 白名单内发射（mode=pilot）
  PASS - pilot 兼容: express 白名单外跳过
  PASS - 回滚: 主开关关闭 → 零 guidance 活动

SMOKE PASS — precision code search is intent-gated, cross-repo, and rollback-safe
```

## 机制

- 意图分类为冻结纯函数（`search_guidance.js`）：lookup / filter / discovery /
  enumeration / statistics / unknown，同一输入输出完全确定。
- 正区 = DISCOVERY + FILTER（历史 Fastify pilot 与跨仓在线资格化的已证明正区）；
  LOOKUP 按 FP1 证据冻结为 Native（"找定义"类任务保持原始行为）。
- 标准会话默认开启（runner 注入两个 flag）；`CODE_GUARD_SEARCH_GUIDANCE=0` 全关，
  `CODE_GUARD_SEARCH_GUIDANCE_AUTO=0` 只关跨仓泛化（回到白名单模式）。
- 注意：本能力改变的是**搜索过程**（怎么搜、搜多大范围、何时收敛），不改变交给
  模型的搜索结果内容——结果级压缩属于独立后续线。
