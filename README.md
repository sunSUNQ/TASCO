# TASCO v0.7

**TASCO**（Tool-output Adaptive Selective Context Optimization）为 Code Agent 的工具输出提供选择性上下文优化。它不是“压缩一切”：只有已验证的正区才会介入；信息精度敏感、未知或不安全的情况始终保持 **Native**（原样交付）。

本仓库根目录就是可部署包。复制或克隆整个仓库到目标机即可使用；无需研发仓、`npm install` 或 Python。

## 三层能力结构

| 层 | 目录 | 负责什么 | 不负责什么 |
| --- | --- | --- | --- |
| Skill | `skills/` | 给 Agent 行为引导：限域阅读、证据链与安全工作流 | 不决定或替换任何工具输出 |
| Spec | `specs/` | 定义环境与任务契约、角色边界 | 不参与压缩判定 |
| Hook | `hooks/` + `core/` + `adapters/` | 在工具调用前后完成资格判断、仲裁、压缩和不同 Agent 的协议接线 | 不猜测未知场景；失败时回退 Native |

硬边界：Skill/Spec 只影响引导；实际输出替换只由 Hook/Core 执行，Adapter 只负责接线。改动 `core/`、`hooks/`、`adapters/` 或 `config/` 后必须重新生成并校验 `deploy_manifest.json`。

## 当前能力边界（按工具类型）

| 工具类型 | v0.7 默认能力 | 已验证正区 | 负区 / 保持 Native | 回滚开关 |
| --- | --- | --- | --- | --- |
| Shell：失败输出 | Failure Carrier → Diagnostic Semantic Compression | 单一根因的高容量测试/构建失败、堆栈与诊断日志 | 编辑、精确断言/原文恢复、全量枚举、多源归因、小输出、unsafe/watch/交互 shell | `CODE_GUARD_FAILURE_CARRIER_AUTO=0` |
| Shell：成功输出 | Terminal-State Success Compression | `exit=0`、完整且未截断的 test/build summary | 失败、unknown、截断、普通 shell、不完整 reporter | `CODE_GUARD_TERMINAL_STATE=0` |
| Shell：重复验证 | Validation Delta | 同一可比较验证命令的重复执行；只交付变化 | 首次运行、无可比 fingerprint、失败 current、不可比较命令 | `CODE_GUARD_VALIDATION_DELTA=0` |
| Shell：并发候选 | Unified Arbitration | 失败诊断 > 稳定 Validation Delta > 成功终态 > Native；一次输出一个 winner | 任意歧义或不满足证据门槛的候选 | 自动 Native |
| Search | Discovery / Filter Guidance | 调用链入口、wrapper→实现、依赖定位、机制发现、同名 symbol 消歧 | LOOKUP（找定义）、枚举、统计、未知意图、大型复杂仓 → Native | `CODE_GUARD_SEARCH_GUIDANCE=0`；`CODE_GUARD_SEARCH_GUIDANCE_AUTO=0` 回到白名单 |
| Read | Task-driven Read Compression | R1 目标符号提取、R2 调用关系边、R3 实现链、R4 重复读抑制、R5 文档章节提取 | R0 无法分类、无 task symbol/map、非入口文件、小读取、无净节省 | `CODE_GUARD_READ_COMPRESSION=0`；`CODE_GUARD_READ_MAP_AUTOBUILD=0` |
| Search Result / Structural | Native / Shadow | 保留研究证据，尚未作为默认输出替换 | 所有生产请求 | 不适用 |

所有能力均 fail-open：异常、低置信度或未命中正区时不阻断 Agent，而是原样交付。

## Quick Start

以下以 `D:\tasco` 为例。CodeAgentCLI 首次使用某个目录前，先在该目录交互运行一次 `codeagentcli` 并确认目录授权；Claude Code 与 OpenCode 不需要此授权步骤。

```powershell
# 1. 获取并进入部署包
git clone https://github.com/sunSUNQ/TASCO.git D:\tasco

# 2. 只读预检
& D:\tasco\tools\test-tasco-preflight.ps1 `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ"

# 3. 运行一次真实 Agent 诊断任务，并启用 TASCO
& D:\tasco\run-tasco-task.ps1 `
  -Agent codeagent -Model "DeepSeek-v4-Flash-SZ" `
  -WorkDir D:\tasco\examples\diagnostic-compression-smoke `
  -Prompt "Run node scripts/emit-diagnostic.js exactly once. Diagnose the root cause. Do not modify files." `
  -EnableTasco

# 4. 查看最近一次会话结论
& D:\tasco\tools\get-latest-tasco-session.ps1 `
  -Path D:\tasco\examples\diagnostic-compression-smoke
```

成功时，实时日志会包含 `applied=diagnostic_semantic`，而观测脚本会报告 `POSITIVE`。若输出保持 Native，不代表安装失败：它可能不在已验证正区。

## 离线测试示例

所有示例都离线、确定性、零模型依赖，直接驱动真实 runtime。完成 Quick Start 后可逐一运行：

```powershell
cd D:\tasco\examples\terminal-state-compression-smoke;  npm run smoke
cd D:\tasco\examples\arbitration-one-winner-smoke;      npm run smoke
cd D:\tasco\examples\validation-delta-smoke;            npm run smoke
cd D:\tasco\examples\failure-carrier-smoke;             npm run smoke
cd D:\tasco\examples\precision-search-smoke;            npm run smoke
cd D:\tasco\examples\read-compression-smoke;            npm run smoke
cd D:\tasco\examples\session-marker-smoke;              npm run smoke
```

| Example | 覆盖能力 | 关键断言 |
| --- | --- | --- |
| `terminal-state-compression-smoke` | Shell 成功终态 | 保留 counts/summary，省略逐 case 噪音 |
| `arbitration-one-winner-smoke` | Shell 仲裁 | 恰好一个 winner，`double_apply=0` |
| `validation-delta-smoke` | Shell 重复验证 | `success_unchanged` / `success_counts_changed`，首次保持 Native |
| `failure-carrier-smoke` | Shell 失败诊断 | 原命令只执行一次，根因保留，unsafe 不改写 |
| `precision-search-smoke` | Search | DISCOVERY/FILTER 注入；LOOKUP/枚举/统计/未知零注入 |
| `read-compression-smoke` | Read | R1/R2/R4/R5 model-visible；R0 与 flag OFF 保持 Native |
| `session-marker-smoke` | 观测对接 | session start/end 与 model-visible 压缩统计 |

完整断言、预期输出与单项运行说明见 [examples/README.md](./examples/README.md)。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [DEPLOYMENT-GUIDE.zh-CN.md](./DEPLOYMENT-GUIDE.zh-CN.md) | 新机部署、常驻接线、卸载与 FAQ |
| [RUNNER-OBSERVABILITY-GUIDE.zh-CN.md](./RUNNER-OBSERVABILITY-GUIDE.zh-CN.md) | runner 参数、会话观测、错误处理与完整能力表 |
| [CAPABILITY-EVIDENCE.zh-CN.md](./CAPABILITY-EVIDENCE.zh-CN.md) | v0.7 各工具域正区、负区与验证依据 |
| [examples/README.md](./examples/README.md) | 全部离线 smoke 索引 |

## 目录结构

```text
TASCO/
├─ run-tasco-task.ps1       # 一键 runner：接入 hooks 并落盘 telemetry
├─ deploy_manifest.json     # v0.7 payload 文件 SHA256 清单
├─ adapters/ core/ hooks/   # Hook/Core/Agent 协议接线
├─ config/                  # 能力配置
├─ tools/                   # 预检、会话观测与维护脚本
├─ examples/                # 离线 smoke 示例
├─ skills/                  # Agent 行为引导
└─ specs/                   # 环境与任务契约
```

## License

本仓库暂未指定开源许可证；正式发布前请由维护者选择并添加许可证。
