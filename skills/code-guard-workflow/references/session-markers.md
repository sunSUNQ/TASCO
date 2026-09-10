# Session Markers 字段说明

打点脚本：`scripts/session_marker.py`。每行一个 JSON 对象，写入
`.code-guard/markers/dashboard.ndjson`（`TASCO_DASHBOARD_LOG` 可覆盖），
设置 `TASCO_DASHBOARD_URL` 时同时 HTTP POST。字段分两类来源：
**参数**（agent 按 SKILL.md 调用时填写）与 **自动**（脚本/环境生成，无需填写）。

## 最小联调集（对接方测试只需以下内容）

需要的文件（共 2 个）：

1. `scripts/session_marker.py`（Python 3 stdlib，零第三方依赖，无需安装 TASCO）
2. 本文档（字段含义 + 校验依据）

联调步骤（任意空目录执行，不要求 git / 不要求 agent）：

```bash
# 1. start 打点
python session_marker.py start --skill test --task "integration test"

# 2. end 打点（可选 outcome: success|partial|failed）
python session_marker.py end --skill test --task "integration test" --outcome success

# 3. 校验：当前目录生成 .code-guard/markers/dashboard.ndjson，共 2 行
#    （session_start + session_end，字段见下表）

# 可选：看板实时接收（二选一或同时）
#   设置 TASCO_DASHBOARD_URL=<看板 HTTP 端点>   -> 每行同时 POST（3s 超时静默失败）
#   设置 TASCO_DASHBOARD_LOG=<文件路径>         -> 改变 NDJSON 落盘位置
```

对接方测试环境变量建议：`CODE_GUARD_TASCO_VERSION`（让 `tasco_version` 字段
有值；未设时为 `unknown`）。`agent` / `model` / `usage.*` 在脱离 TASCO 运行时
为 `unknown` / `null`——属预期，字段契约见下表。

## session_start（skill 激活时）

调用：`python scripts/session_marker.py start --skill <名称> --task "<任务标签>"`

| 字段 | 含义 | 来源 | 是否必须 |
| --- | --- | --- | --- |
| `type` | 行类型，固定 `"session_start"` | 自动 | 必须（自动） |
| `ts` | UTC 时间戳（ISO 8601） | 自动 | 必须（自动） |
| `repo` | 仓库名（当前目录 basename） | 自动 | 必须（自动） |
| `skill` | skill 名称 | `--skill` 参数 | 可选（默认 `code-guard-workflow`） |
| `task` | 任务标签（用户要做什么，如 "bug root cause"） | `--task` 参数 | **建议必填**——看板按任务维度的核心字段 |
| `tasco_version` | TASCO 版本 | manifest 自动，env 兜底 | 自动（可能 `unknown`） |
| `agent` | agent runtime（`claude-code` / `opencode`） | env 自动 | 自动（可能 `unknown`） |
| `model` | 模型名 | env 自动 | 自动（可能 `unknown`） |

示例：

```json
{"type": "session_start", "ts": "2026-09-10T03:38:08.000Z", "repo": "my-repo",
 "skill": "code-guard-workflow", "task": "bug root cause", "tasco_version": "tasco-v0.7",
 "agent": "claude-code", "model": "deepseek-v4-flash"}
```

## session_end（会话结束）

调用：`python scripts/session_marker.py end --skill <名称> --task "<任务标签>" --outcome <结果>`

包含 start 的全部字段（`type` 变为 `"session_end"`），并追加以下三块：

| 字段 | 含义 | 来源 | 是否必须 |
| --- | --- | --- | --- |
| `outcome` | 任务结果：`success` / `partial` / `failed` | `--outcome` 参数 | **建议必填** |
| `usage.turns` | 会话轮数 | 自动（runner summary） | 自动（非 runner 会话为 `null`） |
| `usage.input_tokens` | 输入 token 用量 | 自动（runner summary） | 自动（非 runner 会话为 `null`） |
| `usage.output_tokens` | 输出 token 用量 | 自动（runner summary） | 自动（非 runner 会话为 `null`） |
| `compression.events` | 压缩事件总数 | 自动（遥测汇总） | 必须（自动） |
| `compression.by_strategy` | 各策略/能力次数，如 `{"validation_delta": 1}` | 自动 | 必须（自动） |
| `compression.before_chars` | 原始输出字符总量 | 自动 | 必须（自动） |
| `compression.delivered_chars` | 实际交付字符总量 | 自动 | 必须（自动） |
| `compression.saved_chars` | 节省字符数 | 自动 | 必须（自动）——**仅 model-visible 交付计入**（Metrics Contract V2） |
| `compression.model_visible_events` | 确认送达模型的压缩次数 | 自动 | 必须（自动） |
| `compression.fallback_events` | 介入失败/回退次数（质量哨兵） | 自动 | 必须（自动） |
| `recovery.repeat_reads` | 重复读文件数（R4 ledger） | 自动 | 必须（自动，可为 0） |
| `recovery.re_searches` | 压缩后重新搜索次数 | 预留 | 预留字段（当前恒 0） |

示例：

```json
{"type": "session_end", "ts": "2026-09-10T03:45:34.000Z", "repo": "my-repo",
 "skill": "code-guard-workflow", "task": "build verification", "outcome": "success",
 "tasco_version": "tasco-v0.7", "agent": "claude-code", "model": "deepseek-v4-flash",
 "usage": {"turns": 8, "input_tokens": 31306, "output_tokens": 2135},
 "compression": {"events": 4, "by_strategy": {"extractive_read": 1, "validation_delta": 1},
   "before_chars": 20097, "delivered_chars": 1737, "saved_chars": 18360,
   "model_visible_events": 4, "fallback_events": 0},
 "recovery": {"repeat_reads": 1, "re_searches": 0}}
```

## 弱字段说明（可能为 `null` / `unknown` 的唯一来源）

只有依赖 runner summary 或 env 的字段在脱离 runner 的会话中可能为空：
`tasco_version` / `agent` / `model`（unknown）、`usage.*`（null）。
`compression.*` 与 `recovery.repeat_reads` 来自 hook 层强制落盘的遥测，
任何 TASCO 会话必有，**无 null 风险**。
