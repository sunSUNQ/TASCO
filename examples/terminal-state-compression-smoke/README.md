# TASCO v0.7 Terminal-State Success Compression 示例

一个零依赖、**离线、无模型**的确定性 policy / hook / boundary smoke：验证
Terminal-State Success Compression 能在真实成功 test 输出上**触发压缩且保留合同**，并能观测。

Terminal-State Success Compression 在 TASCO v0.7 中为 **AUTO / DEFAULT ON**。标准 Agent 会话使用：

```powershell
.\deploy\run-tasco-task.ps1 -Agent claude -WorkDir <repo> -Prompt "..." -EnableTasco
```

标准 TASCO runner 会自动开启 Terminal-State。需要回滚时可显式设置：

```powershell
$env:CODE_GUARD_TERMINAL_STATE = "0"
```

这表示明确关闭 Terminal-State，并保持 Native delivery。

```text
真实 node:test 成功输出（tap reporter，> 2KB）
→ 真实 frozen policy hook（post_tool_policy_hook.js）
→ 提取式压缩（envelope + 计数/skipped verbatim + 逐 case 省略记账）
```

能力资格链（Lab → Integration → Agent A/B → Shadow Integration → Release Qualification 全 PASS；
当前为 `AUTO / DEFAULT ON`）：见
`docs/experiments/workflow-compression/p0-agent-ab/` 与 CURRENT_STATUS.md。

## 前置条件

- 本部署闭包（deploy/）为 TASCO v0.5（tasco-v0.5-p1） 发布基线（含 Terminal-State 分支）；
- Node.js（18+，推荐 24）。**不需要** Agent 登录、模型或网络。

## 离线 smoke

```powershell
cd deploy/examples/terminal-state-compression-smoke
npm run smoke        # 或 node scripts/run_smoke.js
```

本命令直接验证 policy / hook 的成功终态识别、语义保留、压缩结果和 flag ON/OFF
边界；它不是标准 runner Default-On wiring 的在线 Qualification。RC4 Default-On
资格来自独立完成的 Release Qualification。

## 预期结果

```text
SMOKE PASS — terminal-state compression fired with contract preserved
```

逐项 PASS 覆盖：离线 flag-off 无 terminal envelope/记账（隔离硬门）；离线 flag-on 压缩
发生（envelope + omitted 记账）；`# pass 44` / `# skipped 1` / `# fail 0`
verbatim 保留；形成节省（raw ~11.3KB → delivered ~6.5KB，~57%）。

## 说明与边界

- 用例刻意含 1 个 skipped case（验证 skipped 保留）与 30 个参数化用例
  （放大输出体量：policy hook 对 <2,000-char 输出走 short_output native，
  冒烟需要进入 terminal 判定区）。
- **直接调用 policy hook 时，flag-off 仍会走 hook 自带的 quick_shell 截断**
  （delivered ≈ 2.5KB、不含 terminal 语义）。真实 Claude Code 链中 flag-off
  的这类 shell 事件根本不会送进 hook（adapter dispatch 设计，见
  `P0-AGENT-AB-V1.md` / `P0-LIMITED-CANARY-V1.md`）——冒烟用
  envelope+记账+计数同现来唯一标识 terminal 提取式语义。
- fixture 用例名刻意不含 `NNN error` 等词汇（frozen classifier 的 line-shape
  失败证据，379e85c 修复）。
- 正区边界：`exit=0 + 可识别的完整 test/build 终态 summary + 输出未截断`；
  未知 reporter / 截断 / 失败 → Native。

## 跑完之后看结果

每次运行落在 `.tasco-runs/<timestamp>/`：

```text
raw-tool-output.txt      原始成功终态输出（hook 收到的文本）
delivered-terminal.txt   flag-on 交付文本（envelope + 保留正文）
checks.json              逐项断言（9 项）
baseline-arm/             flag-off 观测目录（hook 日志/状态）
terminal-arm/             flag-on 观测目录（含 session 日志）
```

在真实 Agent 会话（bridge 链）中，压缩事件与计数记录在
`tasco_compression.ndjson`（applied）/ `tasco_shadow.ndjson`（shadow 记账），
见 [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](../../RUNNER-OBSERVABILITY-GUIDE.zh-CN.md)
与本目录 `P0-NATURAL-SHADOW-CANARY-USAGE.md`。
