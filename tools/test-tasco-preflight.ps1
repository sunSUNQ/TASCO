<# .SYNOPSIS Validates runner inputs and reports actionable, classified errors. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$WorkDir,
  [ValidateSet("claude", "codeagent", "opencode")][string]$Agent = "claude",
  [string]$AgentCommand,
  [string]$Model,
  [switch]$EnableTasco,
  [ValidateSet("0", "1")][string]$RlmEnabled = "0"
)
$ErrorActionPreference = "Stop"
function Report([string]$Code, [string]$Status, [string]$Detail, [string]$Fix) { [pscustomobject]@{ code=$Code; status=$Status; detail=$Detail; fix=$Fix } }
$items = @()
if (Test-Path -LiteralPath $WorkDir -PathType Container) { $items += Report "TASCO_OK_WORKDIR" "PASS" "工作目录可访问" "-" } else { $items += Report "TASCO_E_WORKDIR_NOT_FOUND" "ERROR" "工作目录不存在: $WorkDir" "修正 -WorkDir 为真实项目目录。" }
$deployRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
if ($EnableTasco -and -not (Test-Path -LiteralPath (Join-Path $deployRoot "hooks") -PathType Container)) { $items += Report "TASCO_E_DEPLOY_INCOMPLETE" "ERROR" "未找到 deploy\\hooks" "使用完整 deploy 目录，不要单独复制 tools。" }
if ($Agent -eq "codeagent" -and -not $Model -and -not $env:CODE_GUARD_INTERNAL_MODEL) { $items += Report "TASCO_E_MODEL_REQUIRED" "ERROR" "CodeAgent 需要模型名" "传 -Model <model> 或设置 CODE_GUARD_INTERNAL_MODEL。" }
$command = if ($AgentCommand) { $AgentCommand } elseif ($Agent -eq "claude") { $env:CODE_GUARD_CLAUDE_CMD } elseif ($Agent -eq "codeagent") { $env:CODE_GUARD_CODEAGENT_CMD } else { $env:CODE_GUARD_OPENCODE_CMD }
if ($command -and -not (Test-Path -LiteralPath $command -PathType Leaf) -and -not (Get-Command $command -ErrorAction SilentlyContinue)) { $items += Report "TASCO_E_AGENT_NOT_FOUND" "ERROR" "Agent CLI 不可执行: $command" "传 -AgentCommand <exe>，或修正对应 CODE_GUARD_*_CMD。" } else { $items += Report "TASCO_OK_AGENT_COMMAND" "PASS" "Agent=$Agent；命令将由 runner 自动解析" "-" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { $items += Report "TASCO_E_NODE_NOT_FOUND" "ERROR" "Node.js 不在 PATH" "安装 Node.js 18+ 并重新打开终端。" } else { $items += Report "TASCO_OK_NODE" "PASS" "Node.js 可用" "-" }
if ($RlmEnabled -eq "1" -and -not (Get-Command py,python,python3 -ErrorAction SilentlyContinue)) { $items += Report "TASCO_E_PYTHON_NOT_FOUND" "ERROR" "RLM 已启用但未找到 Python" "设 CODE_GUARD_RLM_ENABLED=0 使用最小模式，或安装 Python 3。" }
$items | Format-Table code,status,detail,fix -Wrap -AutoSize
if (@($items | Where-Object { $_.status -eq "ERROR" }).Count) { exit 2 }
Write-Host "TASCO preflight PASS"
