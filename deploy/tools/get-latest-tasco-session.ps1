<#
.SYNOPSIS
  Prints the latest TASCO session observed under a project or .tasco-runs path.

.EXAMPLE
  & .\tools\get-latest-tasco-session.ps1
  & .\tools\get-latest-tasco-session.ps1 -Path D:\my-project
  & .\tools\get-latest-tasco-session.ps1 -Path D:\my-project\.tasco-runs -AsJson
#>
[CmdletBinding()]
param(
  [string]$Path = (Get-Location).Path,
  [switch]$AsJson
)

$ErrorActionPreference = "Stop"

function Fail([string]$Code, [string]$Message, [string]$Hint) {
  throw "[$Code] $Message`n建议: $Hint"
}

function N($Value) {
  if ($null -eq $Value) { return [double]0 }
  return [double]$Value
}

function Read-JsonLines([string]$File) {
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return @() }
  $items = @()
  foreach ($line in Get-Content -LiteralPath $File) {
    if (-not $line.Trim()) { continue }
    try { $items += ($line | ConvertFrom-Json -ErrorAction Stop) } catch {}
  }
  return @($items)
}

function Resolve-RunsRoot([string]$InputPath) {
  if (-not (Test-Path -LiteralPath $InputPath -PathType Container)) {
    Fail "TASCO_E_PATH_NOT_FOUND" "目录不存在: $InputPath" "传入项目目录、.tasco-runs 目录或一次具体 run 目录。"
  }
  $resolved = (Resolve-Path -LiteralPath $InputPath).Path
  if (Test-Path -LiteralPath (Join-Path $resolved "summary.json") -PathType Leaf) {
    return [pscustomobject]@{ Root = Split-Path -Parent $resolved; ExactRun = $resolved }
  }
  if ((Split-Path -Leaf $resolved) -eq ".tasco-runs") {
    return [pscustomobject]@{ Root = $resolved; ExactRun = $null }
  }
  $child = Join-Path $resolved ".tasco-runs"
  if (Test-Path -LiteralPath $child -PathType Container) {
    return [pscustomobject]@{ Root = $child; ExactRun = $null }
  }
  Fail "TASCO_E_RUNS_ROOT_NOT_FOUND" "未找到 .tasco-runs: $resolved" "可省略 -Path 使用当前项目，或传入项目/.tasco-runs/run 任一层目录。"
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

function Get-ProviderUsage($Usage) {
  if (-not $Usage) {
    return [pscustomobject]@{ input=$null; cache_read=$null; cache_write=$null; output=$null; total=$null; total_source="unavailable" }
  }
  $input = if ($null -ne $Usage.input_tokens) { $Usage.input_tokens } elseif ($null -ne $Usage.input) { $Usage.input } else { $null }
  $output = if ($null -ne $Usage.output_tokens) { $Usage.output_tokens } elseif ($null -ne $Usage.output) { $Usage.output } else { $null }
  $cacheRead = if ($null -ne $Usage.cache_read_input_tokens) { $Usage.cache_read_input_tokens } elseif ($Usage.cache -and $null -ne $Usage.cache.read) { $Usage.cache.read } else { $null }
  $cacheWrite = if ($null -ne $Usage.cache_creation_input_tokens) { $Usage.cache_creation_input_tokens } elseif ($Usage.cache -and $null -ne $Usage.cache.write) { $Usage.cache.write } else { $null }
  if ($null -ne $Usage.total_tokens) { $total = $Usage.total_tokens; $source = "provider" }
  elseif ($null -ne $Usage.total) { $total = $Usage.total; $source = "provider" }
  elseif ($null -ne $input -or $null -ne $output -or $null -ne $cacheRead -or $null -ne $cacheWrite) {
    $total = (N $input) + (N $output) + (N $cacheRead) + (N $cacheWrite)
    $source = "derived_from_provider_components"
  } else { $total = $null; $source = "unavailable" }
  return [pscustomobject]@{ input=$input; cache_read=$cacheRead; cache_write=$cacheWrite; output=$output; total=$total; total_source=$source }
}

function Get-RunRecord([string]$RunDir) {
  $summaryPath = Join-Path $RunDir "summary.json"
  if (-not (Test-Path -LiteralPath $summaryPath -PathType Leaf)) {
    Fail "TASCO_E_SUMMARY_NOT_FOUND" "最近运行尚未生成 summary.json: $RunDir" "等待任务结束，或使用 watch-tasco-session.ps1 实时观察。"
  }
  try { $run = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json -ErrorAction Stop }
  catch { Fail "TASCO_E_SUMMARY_INVALID" "summary.json 无法解析: $summaryPath" "检查任务是否仍在写入，稍后重试。" }

  $session = $run.sessionSummary
  if (-not $session -and $run.sessionSummaryFile -and (Test-Path -LiteralPath $run.sessionSummaryFile)) {
    try { $session = Get-Content -LiteralPath $run.sessionSummaryFile -Raw | ConvertFrom-Json } catch {}
  }
  $decisions = Read-JsonLines (Join-Path $RunDir "context_budget\claude_auto_canary.jsonl")
  $hooks = Read-JsonLines (Join-Path $RunDir "hook_invoked.jsonl")
  $toolCalls = @($hooks | Where-Object { $_.hook -eq "PostToolUse" })
  $toolNames = @($toolCalls | ForEach-Object { [string]$_.tool_name } | Where-Object { $_ } | Sort-Object -Unique)
  if (-not $toolCalls.Count -and $session) {
    $metricFile = Get-ChildItem -LiteralPath $RunDir -Recurse -Filter "tasco_compression.ndjson" -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($metricFile) {
      $metricEvents = Read-JsonLines $metricFile.FullName
      $toolCalls = @($metricEvents)
      $toolNames = @($metricEvents | ForEach-Object { [string]$_.tool } | Where-Object { $_ } | Sort-Object -Unique)
    }
  }
  $usage = Get-ProviderUsage $run.usage
  $recovery = if ($session) { $session.recovery } else { $null }
  $savedTokens = if ($session -and $null -ne $session.saved_tokens_est) { [math]::Round((N $session.saved_tokens_est)) } else { 0 }
  $recoveryTokens = [math]::Ceiling((N $recovery.recovery_cost_chars) / 4)
  $netSavedTokens = $savedTokens - $recoveryTokens
  $applied = if ($session) { [int](N $session.applied_calls) } else { 0 }
  $fallback = if ($session) { [int](N $session.fallback_calls) } else { 0 }
  $netSavedChars = if ($recovery) { N $recovery.net_saved_chars } elseif ($session) { N $session.saved_chars } else { 0 }
  if ($null -eq $run.exitCode) { $outcome = "NEEDS_REVIEW"; $outcomeReason = "missing_exit_code" }
  elseif ([int]$run.exitCode -ne 0) { $outcome = "NEEDS_REVIEW"; $outcomeReason = "task_failed_or_incomplete" }
  elseif ($applied -eq 0) { $outcome = "NEUTRAL"; $outcomeReason = "native_or_not_eligible" }
  elseif ($netSavedChars -gt 0 -and $fallback -eq 0) { $outcome = "POSITIVE"; $outcomeReason = "task_success_and_positive_net_saving" }
  elseif ($netSavedChars -lt 0) { $outcome = "NEGATIVE"; $outcomeReason = "recovery_cost_exceeded_gross_saving" }
  elseif ($fallback -gt 0) { $outcome = "NEEDS_REVIEW"; $outcomeReason = "fallback_observed" }
  else { $outcome = "NEUTRAL"; $outcomeReason = "zero_net_saving" }

  return [pscustomobject][ordered]@{
    run = Split-Path -Leaf $RunDir
    run_dir = $RunDir
    session_id = if ($session) { $session.session_id } else { $null }
    agent = $run.agent
    model = $run.model
    task_type = Get-TaskType $decisions
    task_type_source = if ($decisions.Count) { "router_telemetry" } else { "unavailable" }
    task_status = if ($null -eq $run.exitCode) { "UNKNOWN" } elseif ([int]$run.exitCode -eq 0) { "SUCCESS" } else { "FAILED" }
    exit_code = $run.exitCode
    turns = $run.turns
    provider_tokens = $usage
    tasco_enabled = [bool]$run.tascoEnabled
    tasco_observed = [bool]$session
    selected_calls = if ($session) { [int](N $session.selected_calls) } else { 0 }
    applied_calls = $applied
    fallback_calls = $fallback
    compression = [pscustomobject]@{
      before_chars = if ($session) { [math]::Round((N $session.before_chars)) } else { 0 }
      delivered_chars = if ($session) { [math]::Round((N $session.delivered_chars)) } else { 0 }
      gross_saved_chars = if ($session) { [math]::Round((N $session.saved_chars)) } else { 0 }
      recovery_cost_chars = [math]::Round((N $recovery.recovery_cost_chars))
      net_saved_chars = [math]::Round($netSavedChars)
      reduction_rate = if ($session) { $session.reduction_rate } else { $null }
      gross_saved_tokens_est = $savedTokens
      recovery_tokens_est = $recoveryTokens
      net_saved_tokens_est = $netSavedTokens
      token_mode = "estimated_from_telemetry"
    }
    tools = [pscustomobject]@{ calls = $toolCalls.Count; distinct = $toolNames.Count; names = $toolNames }
    outcome = $outcome
    outcome_reason = $outcomeReason
  }
}

$location = Resolve-RunsRoot $Path
if ($location.ExactRun) { $latest = Get-Item -LiteralPath $location.ExactRun }
else {
  $latest = Get-ChildItem -LiteralPath $location.Root -Directory -ErrorAction Stop |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "summary.json") } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $latest) { Fail "TASCO_E_NO_SESSIONS" "没有找到已完成的 TASCO session。" "先运行 run-tasco-task.ps1，或检查 -Path 是否指向正确项目。" }
$record = Get-RunRecord $latest.FullName

if ($AsJson) { $record | ConvertTo-Json -Depth 8; return }
Write-Host "TASCO 最近 session"
Write-Host "Run/Session : $($record.run) / $($record.session_id)"
Write-Host "任务        : type=$($record.task_type) source=$($record.task_type_source) status=$($record.task_status) exit=$($record.exit_code) turns=$($record.turns)"
Write-Host "运行环境    : agent=$($record.agent) model=$($record.model)"
Write-Host "Provider token: input=$($record.provider_tokens.input) cache_read=$($record.provider_tokens.cache_read) cache_write=$($record.provider_tokens.cache_write) output=$($record.provider_tokens.output) total=$($record.provider_tokens.total) source=$($record.provider_tokens.total_source)"
Write-Host "TASCO       : enabled=$($record.tasco_enabled) observed=$($record.tasco_observed) selected=$($record.selected_calls) applied=$($record.applied_calls) fallback=$($record.fallback_calls)"
Write-Host ("压缩        : {0:N0} -> {1:N0} chars, gross={2:N0}, recovery={3:N0}, net={4:N0}, rate={5:P2}" -f $record.compression.before_chars, $record.compression.delivered_chars, $record.compression.gross_saved_chars, $record.compression.recovery_cost_chars, $record.compression.net_saved_chars, (N $record.compression.reduction_rate))
Write-Host "Token 节省  : gross=$($record.compression.gross_saved_tokens_est) recovery=$($record.compression.recovery_tokens_est) net=$($record.compression.net_saved_tokens_est) mode=$($record.compression.token_mode)"
Write-Host "工具        : calls=$($record.tools.calls) distinct=$($record.tools.distinct) names=$($record.tools.names -join ',')"
Write-Host "效果        : $($record.outcome) ($($record.outcome_reason))"
