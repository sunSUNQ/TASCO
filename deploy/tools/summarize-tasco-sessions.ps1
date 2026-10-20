<#
.SYNOPSIS
  Summarizes all TASCO runs beneath a .tasco-runs directory.

.EXAMPLE
  & .\tools\summarize-tasco-sessions.ps1 -RunsRoot D:\repo\.tasco-runs
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$RunsRoot,
  [switch]$IncludeNative,
  [switch]$AsJson
)

$ErrorActionPreference = "Stop"
function Fail([string]$Code, [string]$Message, [string]$Hint) { throw "[$Code] $Message`n建议: $Hint" }
function N($Value) { if ($null -eq $Value) { return 0 }; return [double]$Value }
if (-not (Test-Path -LiteralPath $RunsRoot -PathType Container)) { Fail "TASCO_E_RUNS_ROOT_NOT_FOUND" "结果根目录不存在: $RunsRoot" "传入 <项目>\\.tasco-runs。" }

$rows = @()
Get-ChildItem -LiteralPath $RunsRoot -Directory -ErrorAction Stop | Sort-Object Name | ForEach-Object {
  $summaryPath = Join-Path $_.FullName "summary.json"
  if (-not (Test-Path -LiteralPath $summaryPath)) { return }
  try { $run = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -ErrorAction Stop } catch { Write-Warning "跳过无效 summary: $summaryPath"; return }
  $s = $run.sessionSummary
  if (-not $s -and -not $IncludeNative) { return }
  $r = if ($s) { $s.recovery } else { $null }
  $rows += [pscustomobject]@{
    run = $_.Name; agent = $run.agent; model = $run.model; exit_code = $run.exitCode; turns = $run.turns
    provider_total_tokens = if ($run.usage) { $run.usage.total_tokens } else { $null }
    selected = if ($s) { $s.selected_calls } else { 0 }; applied = if ($s) { $s.applied_calls } else { 0 }
    gross_saved_chars = if ($s) { [math]::Round((N $s.saved_chars)) } else { 0 }
    recovery_cost_chars = if ($r) { [math]::Round((N $r.recovery_cost_chars)) } else { 0 }
    net_saved_chars = if ($r) { [math]::Round((N $r.net_saved_chars)) } else { 0 }
    reduction_rate = if ($s) { $s.reduction_rate } else { $null }
    recovery_events = if ($r) { $r.detected_events } else { 0 }
    status = if (-not $s) { "NO_TASCO_SESSION" } elseif ((N $s.applied_calls) -gt 0) { "COMPRESSED" } else { "NATIVE_OR_NOT_ELIGIBLE" }
  }
}
if (-not $rows.Count) { Fail "TASCO_E_NO_SUMMARIES" "未找到可汇总的 summary.json。" "先用 run-tasco-task.ps1 运行一次，或传 -IncludeNative 查看未接入 TASCO 的运行。" }
$total = [pscustomobject]@{
  runs = $rows.Count; compressed_runs = @($rows | Where-Object { $_.applied -gt 0 }).Count
  applied_calls = ($rows | Measure-Object applied -Sum).Sum; gross_saved_chars = ($rows | Measure-Object gross_saved_chars -Sum).Sum
  recovery_cost_chars = ($rows | Measure-Object recovery_cost_chars -Sum).Sum; net_saved_chars = ($rows | Measure-Object net_saved_chars -Sum).Sum
  provider_tokens_available_runs = @($rows | Where-Object { $null -ne $_.provider_total_tokens }).Count
}
if ($AsJson) { [pscustomobject]@{ totals = $total; sessions = $rows } | ConvertTo-Json -Depth 6; return }
Write-Host ("TASCO 汇总: runs={0}, compressed_runs={1}, applied_calls={2}, gross_saved_chars={3:N0}, recovery_cost_chars={4:N0}, net_saved_chars={5:N0}, provider_token_runs={6}" -f $total.runs, $total.compressed_runs, $total.applied_calls, $total.gross_saved_chars, $total.recovery_cost_chars, $total.net_saved_chars, $total.provider_tokens_available_runs)
$rows | Format-Table run,status,exit_code,turns,selected,applied,gross_saved_chars,recovery_cost_chars,net_saved_chars,reduction_rate -AutoSize
