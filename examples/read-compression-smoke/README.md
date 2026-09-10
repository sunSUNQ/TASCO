# TASCO Read Compression Smoke（主线⑥：任务驱动 Read 压缩）

**问题**：Agent 按 task 读取代码/文档时，每次都把整份原文重发给模型——重复读、
目标函数之外的 helper、文档里无关章节全部占用上下文。

**本冒烟验证**：read 交付由任务派生的策略接管，全部 model-visible：

```text
R1 局部目标读取   [EXTRACTIVE READ v1]      目标函数 verbatim，无关 helper 剔除
R2 调用关系读取   [READ_RELATION_EVIDENCE]  1-hop 边，只来自 identity map
R4 重复读取       [READ_SUPPRESSED]         内容未变不重发（note 无代码内容）；
                                            内容变化 → refresh（绝不抑制 stale）
R5 大文档定向阅读 [READ_SECTION_EXTRACTION] 命中章节 verbatim，无关章节剔除
R0 无法分类       Native                    完整原文，不猜测
```

flag OFF 时逐字节回滚（无任何 read_task_compression 痕迹）。

## 运行

```powershell
cd deploy\examples\read-compression-smoke
npm run smoke
```

## 期望输出

```text
R1 raw 4xxx -> 9xx chars | R4 repeat 4xxx -> 3xx chars | R2 raw 4xxx -> 3xx chars | R5 raw 4xxx -> 9xx chars
  PASS - flag OFF: 读取保持 Native（无替换）
  PASS - flag OFF: 无 read_task_compression 行（逐字节回滚）
  PASS - R1: 交付 [EXTRACTIVE READ v1]
  PASS - R1: 任务符号 parseConnectionString verbatim 保留
  PASS - R1: 结果保真（443/5432/tls 语义在交付内）
  PASS - R1: 有净节省（< 原文 40%）
  PASS - R4: 重复读 → [READ_SUPPRESSED]
  PASS - R4: suppress note 不含代码内容
  PASS - R4: 内容变化 → refresh（绝不抑制 stale）
  PASS - R2: 交付 [READ_RELATION_EVIDENCE]
  PASS - R2: 边只来自 map（route.js -> handle-request.js）
  PASS - R5: 交付 [READ_SECTION_EXTRACTION]
  PASS - R5: 命中章节保留（Idempotency-Key）
  PASS - R5: 无关章节剔除（rate limits 不在交付内）
  PASS - R0: 无法分类 → Native（无替换）
  PASS - 遥测: 每次交付都有 model-visible 记录
  PASS - 遥测: 全部 read 行 originalLength > compressedLength
  PASS - 看板: start/end 打点被触发（session_marker.py 可用）
  PASS - 看板: session_end 行汇总 saved_chars > 0（仅 model-visible 计入）
  PASS - 看板: session_end 行 strategy 维度齐全
SMOKE PASS — task-driven read compression delivers model-visible extractions, edges, sections and repeat suppression
```

## 看板打点（session markers）

本冒烟同时是 **skill 打点管线的离线确定性验证**：`run_smoke.js` 以与
SKILL.md 完全相同的 `session_marker.py` 脚本驱动 start/end 两个打点，
并把结果写入 `.code-guard/markers/dashboard.ndjson`（看板可 tail 该文件，
或设置 `TASCO_DASHBOARD_URL` 接收 HTTP POST）。session_end 行汇总本会话
全部压缩事件（按 strategy 分维度、saved_chars 仅计 model-visible 交付）。

## 机制

- 真实链路：`claude_bridge.js` UserPromptSubmit（冻结分类器 → 会话任务文件 +
  遥测）→ PostToolUse read leg（单次咨询 policy hook，`delivered<raw` 硬校验）
  → policy hook read_file 分支（`read_runtime.decideReadDelivery`）
- 任务文本来自 `CODE_GUARD_CLAUDE_PROMPT`（标准 runner 注入）；R1 符号不在
  文件正文 → native（fail-closed，不做 keep-first 猜测）
- R2/R3 需要 identity map（`CODE_GUARD_STRUCTURAL_MAP` 或仓内
  `.tasco/identity_map.json`）；无 map → native。边只来自 map，作用域仅限
  任务入口文件本身的读取
- R4 ledger 按会话持久（`context_budget_state.json` 的
  `after_read_deliveries`，含内容指纹与已交付 range）；hash 变化必须 refresh，
  缺信息 fail-open deliver
- 本冒烟关闭 Terminal-State / Validation Delta / Failure Carrier / Search
  以隔离 read primitive；真实会话中优先级由冻结仲裁决定（read 候选只作用于
  read_file 事件，与 shell 域候选按 tool family 互斥）
- 回归证据：`deploy/adapters/claude_bridge_read_compression.test.js`（7/7）、
  `deploy/hooks/post_tool/read_runtime.test.js`（14/14）、真实 Agent A/B
  `hook_ab_test/results/read_ab_20260909/`（5/5 R 类 PASS）
