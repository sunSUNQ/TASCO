# TASCO Arbitration One-Winner Smoke（主线②：A0/A1 多能力自动选择）

**问题**：一次工具输出可能同时满足多种压缩能力（失败诊断 / 验证 delta / 成功终态）。
若各能力各自为政，模型会收到多份替换或互相冲突的内容。

**本冒烟验证**（真实 frozen bridge + AUTO-ARBITRATION-V1）：

```text
one tool result
→ candidates（多能力并行成候选）
→ eligibility
→ arbitration（冻结 precedence）
→ single delivery
→ double_apply_count = 0
```

冻结 precedence：

```text
failure diagnostic > stable validation delta > terminal success > native
```

## 运行

```powershell
cd deploy\examples\arbitration-one-winner-smoke
npm run smoke
```

## 三个格子

| 格子 | 场景 | 期望 winner |
| --- | --- | --- |
| cell1 run1 | 首次成功（无 previous），诊断候选 + 终态候选在场 | `terminal_state_success` |
| cell1 run2 | 三向冲突（诊断候选 + 稳定 VD + 终态同时 eligible） | `validation_delta`（唯一） |
| cell2 | 失败 carrier（original_exit_code=1）+ 成功形态正文 | `diagnostic_semantic`（`failure_diagnostic_precedence` 压过 Terminal） |
| cell3 | malformed carrier | 无 winner → Native（无交付、无记账） |

## 期望输出

```text
cell1 run1 delivery: xxxx chars  winner=terminal
cell1 run2 delivery: 1xx chars  winner=validation_delta (3-way)
cell2 delivery: xxxx chars  winner=diagnostic (failure precedence)
cell3 delivery: (native)  winner=none (native)
  PASS - Cell1 run1: 首次成功 → Terminal 唯一 winner
  PASS - Cell1 run2: 三向候选同时在场
  PASS - Cell1 run2: 稳定 VD 唯一胜出（不落 terminal、不落 native）
  PASS - Cell1: 每次输出只交付一次（double_apply=0）
  ...

SMOKE PASS — one output, one winner, zero double apply
```

## 机制

- 仲裁语义锚定证据而非措辞：失败语义只看 `original_exit_code`（主线④的 carrier
  字段），成功终态看冻结 classifier，VD 看 fingerprint 可比性。
- 三向候选在场时 winner 由证据与冻结 precedence 唯一决定，与执行顺序无关；
  未形成安全唯一 winner 时一律 Native。
