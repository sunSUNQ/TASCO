<#
.SYNOPSIS
  Prints per-session and aggregate TASCO history with positive/negative outcomes.

.EXAMPLE
  & .\tools\get-tasco-session-history.ps1
  & .\tools\get-tasco-session-history.ps1 -Path D:\my-project -Limit 20
  & .\tools\get-tasco-session-history.ps1 -Path D:\my-project\.tasco-runs -AsJson
#>
[CmdletBinding()]
param(
  [string]$Path = (Get-Location).Path,
  [ValidateRange(0, 100000)][int]$Limit = 0,
  [switch]$AsJson
)

$ErrorActionPreference = "Stop"
function Fail([string]$Code, [string]$Message, [string]$Hint) { throw "[$Code] $Message`n建议: $Hint" }
function N($Value) { if ($null -eq $Value) { return [double]0 }; return [double]$Value }
function Read-JsonLines([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  $items = @()
  foreach ($line in Get-Content -LiteralPath $File) { if ($line.Trim()) { try { $items += ($line | ConvertFrom-Json -ErrorAction Stop) } catch {} } }
  return @($items)
}
function Resolve-RunsRoot([string]$InputPath) {
  if (-not (Test-Path -LiteralPath $InputPath -PathType Container)) { Fail "TASCO_E_PATH_NOT_FOUND" "目录不存在: $InputPath" "传入项目目录或 .tasco-runs 目录。" }
  $resolved = (Resolve-Path -LiteralPath $InputPath).Path
  if ((Split-Path -Leaf $resolved) -eq ".tasco-runs") { return $resolved }
  if (Test-Path -LiteralPath (Join-Path $resolved "summary.json") -PathType Leaf) { return Split-Path -Parent $resolved }
  $child = Join-Path $resolved ".tasco-runs"
  if (Test-Path -LiteralPath $child -PathType Container) { return $child }
  Fail "TASCO_E_RUNS_ROOT_NOT_FOUND" "未找到 .tasco-runs: $resolved" "可省略 -Path 使用当前项目，或显式传入结果根目录。"
}
function Get-TaskType($Decisions) {
  $candidates = @($Decisions | Where-Object { $_.matched_intents -or $_.selected_capability -or $_.applied_capability })
  foreach ($decision in @($candidates | Select-Object -Last 1)) {
    $intent = $decision.matched_intents
    if ($intent) {
      if ($intent.diagnosticAnalysis) { return "DIAGNOSTIC" }
      if ($intent.codeFix -or $intent.specToCode -or $intent.mutationRequested) { return "CODE_CHANGE" }
      if ($intent.focusedSearch -or $intent.exhaustiveSearch) { return "SEARCH" }
      if ($intent.callChainAnalysis -or $intent.repoOverview -or $intent.multiSourceSynthesis) { return "STRUCTURAL_ANALYSIS" }
      if ($intent.definitionLookup -or $intent.referenceLookup) { return "LOOKUP" }
      if ($intent.debugging) { return "DEBUGGING" }
    }
    $capability = [string]$decision.selected_capability
    if (-not $capability) { $capability = [string]$decision.applied_capability }
    if ($capability -match "diagnostic") { return "DIAGNOSTIC" }
    if ($capability -match "search") { return "SEARCH" }
    if ($capability -match "read") { return "READ" }
    if ($capability -match "structural") { return "STRUCTURAL_ANALYSIS" }
  }
  return "UNKNOWN"
}
function Get-ProviderTotal($Usage) {
  if (-not $Usage) { return [pscustomobject]@{ value=$null; source="unavailable" } }
  if ($null -ne $Usage.total_tokens) { return [pscustomobject]@{ value=$Usage.total_tokens; source="provider" } }
  if ($null -ne $Usage.total) { return [pscustomobject]@{ value=$Usage.total; source="provider" } }
  $values = @($Usage.input_tokens, $Usage.cache_read_input_tokens, $Usage.cache_creation_input_tokens, $Usage.output_tokens)
  if (@($values | Where-Object { $null -ne $_ }).Count) { return [pscustomobject]@{ value=(($values | ForEach-Object { N $_ } | Measure-Object -Sum).Sum); source="derived_from_provider_components" } }
  if ($null -ne $Usage.input -or $null -ne $Usage.output -or $Usage.cache) { return [pscustomobject]@{ value=((N $Usage.input) + (N $Usage.output) + (N $Usage.cache.read) + (N $Usage.cache.write)); source="derived_from_provider_components" } }
  return [pscustomobject]@{ value=$null; source="unavailable" }
}

$runsRoot = Resolve-RunsRoot $Path
$runDirs = @(Get-ChildItem -LiteralPath $runsRoot -Directory | Sort-Object LastWriteTime -Descending)
if ($Limit -gt 0) { $runDirs = @($runDirs | Select-Object -First $Limit) }
if (-not $runDirs.Count) { Fail "TASCO_E_NO_SESSIONS" "没有找到已完成的 session。" "先运行 run-tasco-task.ps1，或检查 -Path。" }

$rows = @()
foreach ($dir in $runDirs) {
  $summaryPath = Join-Path $dir.FullName "summary.json"
  $summaryState = "complete"
  if (Test-Path -LiteralPath $summaryPath -PathType Leaf) {
    try { $run = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -ErrorAction Stop }
    catch { $summaryState = "invalid"; $run = [pscustomobject]@{} }
  } else {
    $summaryState = "missing"
    $run = [pscustomobject]@{}
  }
  $session = $run.sessionSummary
  if (-not $session -and $run.sessionSummaryFile -and (Test-Path -LiteralPath $run.sessionSummaryFile)) { try { $session = Get-Content -LiteralPath $run.sessionSummaryFile -Raw | ConvertFrom-Json } catch {} }
  $decisions = Read-JsonLines (Join-Path $dir.FullName "context_budget\claude_auto_canary.jsonl")
  $hooks = Read-JsonLines (Join-Path $dir.FullName "hook_invoked.jsonl")
  $tools = @($hooks | Where-Object { $_.hook -eq "PostToolUse" } | ForEach-Object { [string]$_.tool_name } | Where-Object { $_ })
  $toolNames = @($tools | Sort-Object -Unique)
  $provider = Get-ProviderTotal $run.usage
  $recovery = if ($session) { $session.recovery } else { $null }
  $applied = if ($session) { [int](N $session.applied_calls) } else { 0 }
  $fallback = if ($session) { [int](N $session.fallback_calls) } else { 0 }
  $grossChars = if ($session) { N $session.saved_chars } else { 0 }
  $recoveryChars = N $recovery.recovery_cost_chars
  $netChars = if ($recovery) { N $recovery.net_saved_chars } else { $grossChars }
  $grossTokens = if ($session) { [math]::Round((N $session.saved_tokens_est)) } else { 0 }
  $netTokens = $grossTokens - [math]::Ceiling($recoveryChars / 4)
  if ($summaryState -ne "complete") { $outcome = "NEEDS_REVIEW"; $reason = "summary_$summaryState" }
  elseif ($null -eq $run.exitCode -or [int]$run.exitCode -ne 0) { $outcome = "NEEDS_REVIEW"; $reason = "task_failed_or_incomplete" }
  elseif ($applied -eq 0) { $outcome = "NEUTRAL"; $reason = "native_or_not_eligible" }
  elseif ($netChars -gt 0 -and $fallback -eq 0) { $outcome = "POSITIVE"; $reason = "positive_net_saving" }
  elseif ($netChars -lt 0) { $outcome = "NEGATIVE"; $reason = "recovery_cost_exceeded_saving" }
  elseif ($fallback -gt 0) { $outcome = "NEEDS_REVIEW"; $reason = "fallback_observed" }
  else { $outcome = "NEUTRAL"; $reason = "zero_net_saving" }
  $rows += [pscustomobject][ordered]@{
    run=$dir.Name; session_id=if ($session) { $session.session_id } else { $null }; summary_state=$summaryState; task_type=Get-TaskType $decisions
    outcome=$outcome; reason=$reason; agent=$run.agent; model=$run.model; exit_code=$run.exitCode; turns=$run.turns
    provider_tokens=$provider.value; provider_token_source=$provider.source; tasco_enabled=[bool]$run.tascoEnabled
    selected=if ($session) { [int](N $session.selected_calls) } else { 0 }; applied=$applied; fallback=$fallback
    gross_saved_chars=[math]::Round($grossChars); recovery_cost_chars=[math]::Round($recoveryChars); net_saved_chars=[math]::Round($netChars)
    gross_saved_tokens_est=$grossTokens; net_saved_tokens_est=$netTokens
    tool_calls=$tools.Count; distinct_tools=$toolNames.Count; tools=($toolNames -join ",")
  }
}
if (-not $rows.Count) { Fail "TASCO_E_NO_SESSIONS" "没有找到 session 目录。" "确认 -Path 指向正确的项目或 .tasco-runs。" }
$providerRows = @($rows | Where-Object { $null -ne $_.provider_tokens })
$totals = [pscustomobject][ordered]@{
  sessions=$rows.Count
  positive=@($rows | Where-Object outcome -eq "POSITIVE").Count
  negative=@($rows | Where-Object outcome -eq "NEGATIVE").Count
  neutral=@($rows | Where-Object outcome -eq "NEUTRAL").Count
  needs_review=@($rows | Where-Object outcome -eq "NEEDS_REVIEW").Count
  tasco_enabled=@($rows | Where-Object tasco_enabled).Count
  tasco_applied=@($rows | Where-Object { $_.applied -gt 0 }).Count
  provider_token_sessions=$providerRows.Count
  provider_tokens=if ($providerRows.Count) { ($providerRows | Measure-Object provider_tokens -Sum).Sum } else { $null }
  gross_saved_chars=($rows | Measure-Object gross_saved_chars -Sum).Sum
  recovery_cost_chars=($rows | Measure-Object recovery_cost_chars -Sum).Sum
  net_saved_chars=($rows | Measure-Object net_saved_chars -Sum).Sum
  gross_saved_tokens_est=($rows | Measure-Object gross_saved_tokens_est -Sum).Sum
  net_saved_tokens_est=($rows | Measure-Object net_saved_tokens_est -Sum).Sum
  tool_calls=($rows | Measure-Object tool_calls -Sum).Sum
}

if ($AsJson) { [pscustomobject]@{ totals=$totals; sessions=$rows } | ConvertTo-Json -Depth 8; return }
Write-Host ("TASCO 历史: sessions={0} positive={1} negative={2} neutral={3} needs_review={4}" -f $totals.sessions,$totals.positive,$totals.negative,$totals.neutral,$totals.needs_review)
Write-Host ("介入/节省: enabled={0} applied={1} gross_chars={2:N0} recovery_chars={3:N0} net_chars={4:N0} gross_tokens_est={5:N0} net_tokens_est={6:N0}" -f $totals.tasco_enabled,$totals.tasco_applied,$totals.gross_saved_chars,$totals.recovery_cost_chars,$totals.net_saved_chars,$totals.gross_saved_tokens_est,$totals.net_saved_tokens_est)
Write-Host "Provider token: sessions=$($totals.provider_token_sessions)/$($totals.sessions) total=$($totals.provider_tokens)（仅汇总有真实 provider usage 的 session）"
$rows | Format-Table run,task_type,outcome,exit_code,turns,provider_tokens,selected,applied,fallback,net_saved_tokens_est,tool_calls,distinct_tools,tools -AutoSize
