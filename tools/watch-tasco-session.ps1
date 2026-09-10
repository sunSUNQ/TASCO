<#
.SYNOPSIS
  Watches one TASCO run directory and prints agent usage, tool/hook activity,
  and compression/recovery totals without changing the session.

.EXAMPLE
  & .\tools\watch-tasco-session.ps1 -RunDir D:\repo\.tasco-runs\20260903-120000 -Follow
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RunDir,
  [switch]$Follow,
  [ValidateRange(200, 10000)][int]$PollMilliseconds = 750
)

$ErrorActionPreference = "Stop"

function Fail([string]$Code, [string]$Message, [string]$Hint) {
  throw "[$Code] $Message`n建议: $Hint"
}

function NumberOrZero($Value) {
  if ($null -eq $Value) { return 0 }
  return [double]$Value
}

function Get-JsonLines([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return @() }
  $items = @()
  foreach ($line in Get-Content -LiteralPath $Path -ErrorAction Stop) {
    if (-not $line.Trim()) { continue }
    try { $items += ($line | ConvertFrom-Json -ErrorAction Stop) } catch {}
  }
  return $items
}

if (-not (Test-Path -LiteralPath $RunDir -PathType Container)) {
  Fail "TASCO_E_RUN_NOT_FOUND" "运行目录不存在: $RunDir" "传入 .tasco-runs 下的一次运行目录。"
}
$runPath = (Resolve-Path -LiteralPath $RunDir).Path
$summaryPath = Join-Path $runPath "summary.json"
$streamPath = Join-Path $runPath "claude.stream-json.log"
$hookPath = Join-Path $runPath "hook_invoked.jsonl"
$eventPath = Join-Path $runPath "context_budget\claude_auto_canary.jsonl"
$lastSignature = ""

do {
  $summary = $null
  if (Test-Path -LiteralPath $summaryPath) {
    try { $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch {}
  }
  $hooks = Get-JsonLines $hookPath
  $events = Get-JsonLines $eventPath
  $compressions = @($events | Where-Object { $_.type -eq "compression" })
  $decisions = @($events | Where-Object { $_.selected_capability -or $_.applied_capability })
  $applied = @($decisions | Where-Object { $_.applied_capability -and $_.applied_capability -ne "native" })
  $session = if ($summary) { $summary.sessionSummary } else { $null }
  if (-not $session) {
    $sessionFile = Get-ChildItem -LiteralPath $runPath -Recurse -Filter "session_summary.json" -File -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($sessionFile) { try { $session = Get-Content -LiteralPath $sessionFile.FullName -Raw | ConvertFrom-Json } catch {} }
  }
  $usage = if ($summary) { $summary.usage } else { $null }
  $lastTool = if ($hooks.Count) { $hooks[-1].tool_name } else { "-" }
  $sig = "$($hooks.Count)|$($events.Count)|$($summary.exitCode)|$($session.updated_at)|$($usage.total_tokens)"
  if ($sig -ne $lastSignature) {
    Write-Host "TASCO session monitor  run=$runPath"
    Write-Host "状态: $(if ($summary) { "已结束 (exit=$($summary.exitCode))" } else { "运行中或尚未写入 summary" })"
    Write-Host "Agent: $(if ($summary) { $summary.agent } else { "unknown" })  Model: $(if ($summary) { $summary.model } else { "unknown" })  Turns: $(if ($summary) { $summary.turns } else { "unknown" })"
    if ($usage) {
      Write-Host "Provider token: input=$($usage.input_tokens) cache_read=$($usage.cache_read_input_tokens) output=$($usage.output_tokens) total=$($usage.total_tokens)"
    } else {
      Write-Host "Provider token: 暂不可用（等待 Agent 的 stream-json usage/result 事件；不会用字符数伪装为真实 token）"
    }
    Write-Host "工具/Hook: hook=$($hooks.Count) last_tool=$lastTool  decisions=$($decisions.Count) applied=$($applied.Count) compression_events=$($compressions.Count)"
    if ($session) {
      $recovery = $session.recovery
      Write-Host ("压缩: before={0:N0} delivered={1:N0} gross_saved={2:N0} ({3:P1})" -f (NumberOrZero $session.before_chars), (NumberOrZero $session.delivered_chars), (NumberOrZero $session.saved_chars), (NumberOrZero $session.reduction_rate))
      Write-Host ("净效果: recovery_events={0} recovery_cost={1:N0} net_saved={2:N0}" -f (NumberOrZero $recovery.detected_events), (NumberOrZero $recovery.recovery_cost_chars), (NumberOrZero $recovery.net_saved_chars))
    } else {
      Write-Host "压缩: 尚未生成 session_summary.json（未触发压缩或 session 仍在运行均可能）。"
    }
    if ($events.Count) {
      $recent = $events[-1]
      Write-Host "最近决策: selected=$($recent.selected_capability) applied=$($recent.applied_capability) tool=$($recent.toolName) fallback=$($recent.fallback_reason)"
    }
    $lastSignature = $sig
  }
  if (-not $Follow -or $summary) { break }
  Start-Sleep -Milliseconds $PollMilliseconds
} while ($true)
