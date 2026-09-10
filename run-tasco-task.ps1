<#!
.SYNOPSIS
Runs one Claude Code task and streams token/turn/hook/TASCO telemetry.

.EXAMPLE
& D:\tasco-deploy\run-tasco-task.ps1 -WorkDir D:\my-repo -Prompt "Run npm test and explain the first failure." -EnableTasco
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Prompt,
  [string]$WorkDir = (Get-Location).Path,
  [ValidateSet("claude", "codeagent", "opencode")][string]$Agent = "claude",
  [switch]$EnableTasco,
  [string]$ClaudeCommand = $env:CODE_GUARD_CLAUDE_CMD,
  [string]$CodeAgentCommand = $env:CODE_GUARD_CODEAGENT_CMD,
  [string]$OpenCodeCommand = $env:CODE_GUARD_OPENCODE_CMD,
  [string]$OpenCodeModel = $env:CODE_GUARD_OPENCODE_MODEL,
  [string]$Model,
  [string]$TascoVersion = $env:CODE_GUARD_TASCO_VERSION,
  [int]$PollMilliseconds = 750
)

$ErrorActionPreference = "Stop"
$deployRoot = Split-Path -Parent $PSCommandPath
$workCandidate = Resolve-Path -LiteralPath $WorkDir -ErrorAction SilentlyContinue
if (-not $workCandidate -or -not (Test-Path -LiteralPath $WorkDir -PathType Container)) { throw "[TASCO_E_WORKDIR_NOT_FOUND] WorkDir does not exist: $WorkDir`n建议: 传入实际项目根目录。" }
$workRoot = $workCandidate.Path
if (-not (Test-Path -LiteralPath (Join-Path $deployRoot "hooks"))) { throw "[TASCO_E_DEPLOY_INCOMPLETE] Missing TASCO hooks under $deployRoot`n建议: 使用完整 deploy 目录，不要单独复制 runner。" }
if ($Agent -eq "claude" -and -not $ClaudeCommand) { $ClaudeCommand = "claude" }
if ($Agent -eq "codeagent" -and -not $CodeAgentCommand) {
  # Existing qualification used CODE_GUARD_CLAUDE_CMD for CodeAgentCLI; retain
  # that fallback, but prefer the explicit CodeAgent-specific variable.
  $CodeAgentCommand = if ($env:CODE_GUARD_CLAUDE_CMD) { $env:CODE_GUARD_CLAUDE_CMD } else { "codeagentcli" }
}
if ($Agent -eq "opencode" -and -not $OpenCodeCommand) {
  $candidates = @(
    (Join-Path $env:APPDATA "npm\node_modules\opencode-ai\bin\opencode.exe")
  )
  $OpenCodeCommand = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $OpenCodeCommand) { throw "[TASCO_E_AGENT_NOT_FOUND] OpenCode executable not found.`n建议: 传 -OpenCodeCommand <path-to-opencode.exe> 或设置 CODE_GUARD_OPENCODE_CMD。" }
}
if ($Agent -eq "opencode" -and -not $OpenCodeModel) { $OpenCodeModel = "deepseek/deepseek-v4-flash" }
if ($Agent -eq "claude" -and -not $Model) { $Model = $env:CODE_GUARD_CLAUDE_MODEL }
if ($Agent -eq "claude" -and -not $Model) { $Model = "deepseek-v4-flash" }
$agentCommand = if ($Agent -eq "codeagent") { $CodeAgentCommand } elseif ($Agent -eq "opencode") { $OpenCodeCommand } else { $ClaudeCommand }
if ($Agent -eq "claude" -and $agentCommand -eq "claude") {
  $candidates = @(
    (Join-Path $env:APPDATA "npm\claude.cmd"),
    (Join-Path $env:APPDATA "npm\claude.ps1"),
    (Join-Path $env:APPDATA "npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe"),
    (Join-Path $env:USERPROFILE ".local\bin\claude.exe")
  )
  $agentCommand = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $agentCommand) { throw "[TASCO_E_AGENT_NOT_FOUND] Claude Code executable not found.`n建议: 传 -ClaudeCommand <path-to-claude.exe> 或设置 CODE_GUARD_CLAUDE_CMD。" }
}

# npm/global installs expose different launch shims across Claude Code versions
# and PowerShell versions. Normalize each entry point to a real process plus
# arguments so Start-Process never tries to execute a .ps1/.cmd as an .exe.
function Resolve-CommandPath([string]$Command) {
  if (-not $Command) { return $null }
  if (Test-Path -LiteralPath $Command -PathType Leaf) { return (Resolve-Path -LiteralPath $Command).Path }
  $resolved = Get-Command $Command -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($resolved -and $resolved.Source) { return $resolved.Source }
  return $Command
}

function Get-ProcessLaunch([string]$Command, [string[]]$CliArgs) {
  $path = Resolve-CommandPath $Command
  $ext = [System.IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($ext -in @(".cmd", ".bat")) {
    $line = 'call "' + $path.Replace('"', '""') + '" ' + ($CliArgs -join " ")
    return @{ FilePath = $env:ComSpec; ArgumentList = "/d /s /c `"$line`"" }
  }
  if ($ext -eq ".ps1") {
    $pwsh = (Get-Command pwsh -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    if (-not $pwsh) { $pwsh = (Get-Command powershell -ErrorAction Stop | Select-Object -First 1).Source }
    return @{ FilePath = $pwsh; ArgumentList = "-NoProfile -ExecutionPolicy Bypass -File `"$path`" " + ($CliArgs -join " ") }
  }
  return @{ FilePath = $path; ArgumentList = ($CliArgs -join " ") }
}

function Quote-Arg([string]$Value) { '"' + $Value.Replace('"', '\"') + '"' }
function New-RunId { "{0:yyyyMMdd-HHmmss}" -f (Get-Date) }
function Read-NewLines([string]$Path, [long]$Offset) {
  if (-not (Test-Path -LiteralPath $Path)) { return @{ Offset = $Offset; Lines = @() } }
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
  try {
    if ($Offset -gt $stream.Length) { $Offset = 0 }
    $stream.Seek($Offset, [System.IO.SeekOrigin]::Begin) | Out-Null
    $reader = [System.IO.StreamReader]::new($stream)
    $text = $reader.ReadToEnd()
    @{ Offset = $stream.Position; Lines = @($text -split "`r?`n" | Where-Object { $_ }) }
  } finally { $stream.Dispose() }
}

# PS 5.1 已知问题:Start-Process -RedirectStandardOutput 在子进程退出后会
# 关闭进程句柄且不缓存退出码,导致 $process.ExitCode 恒为 $null。启动时用
# OpenProcess 自持一个原生句柄,结束时用 GetExitCodeProcess 直读权威退出码;
# Add-Type 失败(罕见)则回退到 managed ExitCode。
$exitCodeNative = $false
try {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TascorunExitCode { [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId); [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode); [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr hObject); }'
  $exitCodeNative = $true
} catch { Write-Warning "exit-code helper unavailable; falling back to managed ExitCode" }
$rawProcessHandle = [IntPtr]::Zero

# TASCO 状态根直接落在 run 目录(不再套一层 code-guard),会话目录
# <run>/<session_id> 由 hooks 按 CODE_GUARD_BASE_DIR 自动创建。
$runDir = Join-Path $workRoot (".tasco-runs\" + (New-RunId))
New-Item -ItemType Directory -Force -Path $runDir | Out-Null
$stdoutFile = Join-Path $runDir "claude.stream-json.log"
$stderrFile = Join-Path $runDir "claude.stderr.log"
$summaryFile = Join-Path $runDir "summary.json"
$terminalReason = ""
$settingsDir = Join-Path $workRoot $(if ($Agent -eq "codeagent") { ".cac" } elseif ($Agent -eq "opencode") { ".opencode" } else { ".claude" })
$settingsFile = Join-Path $settingsDir $(if ($Agent -eq "codeagent") { "settings.json" } elseif ($Agent -eq "opencode") { "plugins\governance.js" } else { "settings.local.json" })
$createdSettings = $false
$createdOcPkg = $false

if ($EnableTasco) {
  if (Test-Path -LiteralPath $settingsFile) {
    throw "Refusing to overwrite existing $settingsFile. Merge the hook manually or remove that file first."
  }
  New-Item -ItemType Directory -Force -Path $settingsDir | Out-Null
  if ($Agent -eq "opencode") {
    # OpenCode V1 走插件协议（tool.execute.before/after），不读 .claude hooks。
    # 插件从部署包复制到项目 .opencode/plugins/，运行时通过
    # CODE_GUARD_DEPLOY_ROOT / CODE_GUARD_HOOK_DIR 解析冻结闭包。
    $pluginDir = Join-Path $settingsDir "plugins"
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    Copy-Item -LiteralPath (Join-Path $deployRoot "plugin\governance.js") -Destination $settingsFile -Force
    $ocPkg = Join-Path $settingsDir "package.json"
    if (-not (Test-Path -LiteralPath $ocPkg)) {
      [System.IO.File]::WriteAllText($ocPkg, "{`n  `"type`": `"module`"`n}`n", [System.Text.UTF8Encoding]::new($false))
      $createdOcPkg = $true
    }
    $ocCfg = Join-Path $workRoot "opencode.json"
    if (-not (Test-Path -LiteralPath $ocCfg)) {
      [System.IO.File]::WriteAllText($ocCfg, "{`n  `"$schema`": `"https://opencode.ai/config.json`",`n  `"permission`": {`n    `"read`": `"allow`",`n    `"grep`": `"allow`",`n    `"glob`": `"allow`",`n    `"skill`": `"allow`",`n    `"edit`": `"ask`",`n    `"task`": `"ask`",`n    `"bash`": {`n      `"*`": `"ask`",`n      `"git status*`": `"allow`",`n      `"git diff*`": `"allow`",`n      `"git log*`": `"allow`",`n      `"git show*`": `"allow`",`n      `"git rev-parse*`": `"allow`",`n      `"git remote*`": `"allow`"`n    }`n  }`n}`n", [System.Text.UTF8Encoding]::new($false))
    }
    $createdSettings = $true
  } else {
    $node = (Get-Command node -ErrorAction Stop).Source.Replace('\', '/')
    $bridge = (Join-Path $deployRoot "adapters\claude_bridge.js").Replace('\', '/')
  $settings = @{ hooks = @{
    PreToolUse = @(@{ matcher = "*"; hooks = @(@{ type = "command"; command = "$(Quote-Arg $node) $(Quote-Arg $bridge)" }) })
    PostToolUse = @(@{ matcher = "*"; hooks = @(@{ type = "command"; command = "$(Quote-Arg $node) $(Quote-Arg $bridge)" }) })
    # UserPromptSubmit leg (Line-5 precision search guidance transport; the
    # bridge answers {} / allow when guidance is not enabled).
    UserPromptSubmit = @(@{ hooks = @(@{ type = "command"; command = "$(Quote-Arg $node) $(Quote-Arg $bridge)" }) })
    } }
    [System.IO.File]::WriteAllText($settingsFile, ($settings | ConvertTo-Json -Depth 8), [System.Text.UTF8Encoding]::new($false))
    $createdSettings = $true
  }
}

$saved = @{}
foreach ($key in @("CODE_GUARD_HOOK_DIR", "CODE_GUARD_AGENT_RUNTIME", "CODE_GUARD_DEPLOY_ROOT", "CODE_GUARD_BASE_DIR", "CODE_GUARD_AUTO_CANARY_V1A", "CODE_GUARD_AUTO_CANARY_REQUESTED_EXPERIMENT", "CODE_GUARD_CLAUDE_PROMPT", "CODE_GUARD_INTERNAL_CLI_MODE", "CODE_GUARD_INTERNAL_MODEL", "CODE_GUARD_OPENCODE_MODEL", "CODE_GUARD_MODEL", "CODE_GUARD_TASCO_VERSION", "CODE_GUARD_TERMINAL_STATE")) { $saved[$key] = [Environment]::GetEnvironmentVariable($key, "Process") }
try {
  if ($Agent -eq "codeagent") {
    $resolvedModel = if ($Model) { $Model } else { $env:CODE_GUARD_INTERNAL_MODEL }
    if (-not $resolvedModel) { throw "-Agent codeagent requires -Model (or CODE_GUARD_INTERNAL_MODEL)." }
    $env:CODE_GUARD_INTERNAL_CLI_MODE = "1"
    $env:CODE_GUARD_INTERNAL_MODEL = $resolvedModel
  }
  if ($EnableTasco) {
    $env:CODE_GUARD_HOOK_DIR = Join-Path $deployRoot "hooks"
    $env:CODE_GUARD_AGENT_RUNTIME = if ($Agent -eq "opencode") { "opencode" } else { "claude-code" }
    if ($Agent -eq "opencode") { $env:CODE_GUARD_DEPLOY_ROOT = $deployRoot }
    $env:CODE_GUARD_BASE_DIR = $runDir
    $env:CODE_GUARD_AUTO_CANARY_V1A = "1"
    $env:CODE_GUARD_AUTO_CANARY_REQUESTED_EXPERIMENT = "interactive_task"
    $env:CODE_GUARD_CLAUDE_PROMPT = $Prompt
    if ($Agent -eq "opencode") { $env:CODE_GUARD_OPENCODE_MODEL = $OpenCodeModel }
    $env:CODE_GUARD_MODEL = if ($Agent -eq "opencode") { $OpenCodeModel } elseif ($Agent -eq "codeagent") { $env:CODE_GUARD_INTERNAL_MODEL } else { $Model }
    $env:CODE_GUARD_TASCO_VERSION = if ($TascoVersion) { $TascoVersion } else { "tasco-v0.7" }
    # Terminal-State is enabled by default for standard TASCO sessions.
    # An explicit process-level 0 remains the Native rollback escape hatch;
    # A/B runners set their own arm environment independently.
    if ($env:CODE_GUARD_TERMINAL_STATE -ne "0") { $env:CODE_GUARD_TERMINAL_STATE = "1" }
    # Validation Delta (M3, repeated validation reports only the change) is
    # enabled by default for standard TASCO sessions; explicit 0 rolls back to
    # no-delta (first success falls through to Terminal-State per the frozen
    # arbitration precedence).
    if ($env:CODE_GUARD_VALIDATION_DELTA -ne "0") { $env:CODE_GUARD_VALIDATION_DELTA = "1" }
    # P1 Failure Diagnostic (auto failure carrier) mirrors the Terminal-State
    # default-on policy: enabled for standard TASCO sessions, explicit
    # process-level 0 keeps the M3-era legacy failure path (no rewrite).
    if ($env:CODE_GUARD_FAILURE_CARRIER_AUTO -ne "0") { $env:CODE_GUARD_FAILURE_CARRIER_AUTO = "1" }
    # Line-5 precision code search (generalized AUTO) mirrors the default-on
    # policy: guidance fires on the frozen DISCOVERY/FILTER intent zone across
    # repos; explicit 0 keeps the session fully guidance-free.
    if ($env:CODE_GUARD_SEARCH_GUIDANCE -ne "0") { $env:CODE_GUARD_SEARCH_GUIDANCE = "1" }
    if ($env:CODE_GUARD_SEARCH_GUIDANCE_AUTO -ne "0") { $env:CODE_GUARD_SEARCH_GUIDANCE_AUTO = "1" }
    # Line-6 task-driven read compression mirrors the default-on policy:
    # R1-R5 read primitives + arbitration fire on the frozen task->strategy
    # mapping; explicit 0 keeps reads fully native. R2/R3 additionally need
    # an identity map (CODE_GUARD_STRUCTURAL_MAP or <repo>/.tasco/identity_map.json);
    # without one they fail-closed to Native.
    if ($env:CODE_GUARD_READ_COMPRESSION -ne "0") { $env:CODE_GUARD_READ_COMPRESSION = "1" }
  } else {
    Remove-Item Env:CODE_GUARD_AUTO_CANARY_V1A -ErrorAction SilentlyContinue
  }
  if ($Agent -eq "opencode") {
    $args = @("run", "--dir", (Quote-Arg $workRoot), "-m", (Quote-Arg $OpenCodeModel), "--auto", "--format", "json", (Quote-Arg $Prompt))
    $effectiveModel = $OpenCodeModel
  } else {
    $args = @("-p", (Quote-Arg $Prompt), "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions")
    $effectiveModel = if ($Agent -eq "codeagent") { $env:CODE_GUARD_INTERNAL_MODEL } else { $Model }
    if ($effectiveModel) { $args += @("--model", (Quote-Arg $effectiveModel)) }
  }
  $launch = Get-ProcessLaunch $agentCommand $args
  $process = Start-Process -FilePath $launch.FilePath -ArgumentList $launch.ArgumentList -WorkingDirectory $workRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
  if ($exitCodeNative) { try { $rawProcessHandle = [TascorunExitCode]::OpenProcess(0x1000, $false, $process.Id) } catch {} }
  Write-Host "[tasco] agent=$Agent run=$runDir enabled=$EnableTasco pid=$($process.Id)"
  $stdoutOffset = 0L; $hookOffset = 0L; $eventOffset = 0L; $usage = @{}; $turns = 0
  $hookFile = Join-Path $runDir "hook_invoked.jsonl"
  $eventFile = Join-Path $runDir "context_budget\claude_auto_canary.jsonl"
  while (-not $process.HasExited) {
    $read = Read-NewLines $stdoutFile $stdoutOffset; $stdoutOffset = $read.Offset
    foreach ($line in $read.Lines) {
      try { $obj = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
      if ($Agent -eq "opencode") {
        if ($obj.type -eq "step_finish") {
          $turns += 1
          if ($obj.part -and $obj.part.tokens) { $usage = $obj.part.tokens }
          if ($obj.part -and $obj.part.reason) { $terminalReason = $obj.part.reason }
        }
        if ($obj.type -eq "error") { $terminalReason = "error" }
        if ($usage -or $turns -gt 0) { Write-Host "[usage] turns=$turns input=$($usage.input) cache=$($usage.cache.read) output=$($usage.output)" }
      } else {
        if ($obj.usage) { $usage = $obj.usage }
        if ($obj.num_turns -and [int]$obj.num_turns -gt $turns) { $turns = [int]$obj.num_turns }
        if ($obj.usage -or $obj.num_turns) { Write-Host "[usage] turns=$turns input=$($usage.input_tokens) cache=$($usage.cache_read_input_tokens) output=$($usage.output_tokens)" }
      }
    }
    if ($EnableTasco) {
      $read = Read-NewLines $hookFile $hookOffset; $hookOffset = $read.Offset
      foreach ($line in $read.Lines) { try { $h = $line | ConvertFrom-Json; Write-Host "[hook] $($h.hook) $($h.tool_name)" } catch {} }
      $read = Read-NewLines $eventFile $eventOffset; $eventOffset = $read.Offset
      foreach ($line in $read.Lines) { try { $e = $line | ConvertFrom-Json; Write-Host "[tasco] selected=$($e.selected_capability) applied=$($e.applied_capability) tool=$($e.toolName) fallback=$($e.fallback_reason)" } catch {} }
    }
    Start-Sleep -Milliseconds $PollMilliseconds
    $process.Refresh()
  }
  $process.WaitForExit()
  # PS 5.1:重定向输出下 managed ExitCode 恒为 $null(句柄已被 Start-Process
  # 内部机制关闭);优先用启动时自持的原生句柄直读退出码。
  $exitCode = $process.ExitCode
  if ($null -eq $exitCode -and $exitCodeNative -and $rawProcessHandle -ne [IntPtr]::Zero) {
    $nativeCode = [uint32]0
    if ([TascorunExitCode]::GetExitCodeProcess($rawProcessHandle, [ref]$nativeCode)) { $exitCode = [int]$nativeCode }
  }
  if ($null -eq $exitCode) { Write-Warning "[tasco] exit code unavailable after WaitForExit; assuming failure"; $exitCode = 1 }
  # Claude 的 terminal result 事件是权威口径；opencode 以最后一个 step_finish 为准。
  if ($Agent -eq "opencode") {
    # opencode step_finish.tokens 是单步增量，跨 step 累加才是会话口径。
    $usage = @{ total = 0; input = 0; output = 0; reasoning = 0; cache = @{ read = 0; write = 0 } }
    $turns = 0
    if (Test-Path -LiteralPath $stdoutFile) {
      foreach ($rawLine in Get-Content -LiteralPath $stdoutFile) {
        try { $finalEvent = $rawLine | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($finalEvent.type -eq "step_finish") {
          $turns += 1
          if ($finalEvent.part -and $finalEvent.part.tokens) {
            $t = $finalEvent.part.tokens
            $usage.total += [int]($t.total -as [int])
            $usage.input += [int]($t.input -as [int])
            $usage.output += [int]($t.output -as [int])
            $usage.reasoning += [int]($t.reasoning -as [int])
            if ($t.cache) {
              $usage.cache.read += [int]($t.cache.read -as [int])
              $usage.cache.write += [int]($t.cache.write -as [int])
            }
          }
          if ($finalEvent.part -and $finalEvent.part.reason) { $terminalReason = $finalEvent.part.reason }
        }
      }
    }
  } elseif (Test-Path -LiteralPath $stdoutFile) {
    foreach ($rawLine in Get-Content -LiteralPath $stdoutFile) {
      try { $finalEvent = $rawLine | ConvertFrom-Json -ErrorAction Stop } catch { continue }
      if ($finalEvent.type -eq "result") {
        if ($finalEvent.usage) { $usage = $finalEvent.usage }
        if ($finalEvent.num_turns) { $turns = [int]$finalEvent.num_turns }
      }
    }
  }
  # 压缩结论直接内嵌进 summary.json,避免为了拿 session 累计还要下钻
  # <session_id>/tasco_metrics 多层目录;多 session 时取最后更新的一个。
  $sessionSummaryFile = $null; $sessionSummary = $null
  if ($EnableTasco) {
    $sessionSummaryFile = Get-ChildItem -LiteralPath $runDir -Recurse -Filter "session_summary.json" -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Directory.Name -eq "tasco_metrics" } |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($sessionSummaryFile) {
      $sessionSummaryFile = $sessionSummaryFile.FullName
      try { $sessionSummary = Get-Content -LiteralPath $sessionSummaryFile -Raw | ConvertFrom-Json } catch { $sessionSummaryFile = $null }
    }
  }
  $summary = @{ agent = $Agent; command = $agentCommand; model = $effectiveModel; terminalReason = $terminalReason; runDir = $runDir; tascoEnabled = [bool]$EnableTasco; exitCode = $exitCode; turns = $turns; usage = $usage; stdout = $stdoutFile; stderr = $stderrFile; hookTelemetry = if ($EnableTasco) { $hookFile } else { $null }; tascoTelemetry = if ($EnableTasco) { $eventFile } else { $null }; sessionSummaryFile = $sessionSummaryFile; sessionSummary = $sessionSummary }
  $summary | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $summaryFile -Encoding utf8
  Write-Host "[tasco] exit=$exitCode turns=$turns summary=$summaryFile sessionSummary=$sessionSummaryFile"
  exit $exitCode
} finally {
  if ($rawProcessHandle -ne [IntPtr]::Zero) { try { [TascorunExitCode]::CloseHandle($rawProcessHandle) | Out-Null } catch {} }
  foreach ($key in $saved.Keys) { if ($null -eq $saved[$key]) { Remove-Item "Env:$key" -ErrorAction SilentlyContinue } else { Set-Item "Env:$key" $saved[$key] } }
  if ($createdSettings) {
    Remove-Item -LiteralPath $settingsFile -Force -ErrorAction SilentlyContinue
    if ($Agent -eq "opencode") {
      $ocCfg = Join-Path $workRoot "opencode.json"
      Remove-Item -LiteralPath $ocCfg -Force -ErrorAction SilentlyContinue
      $ocPkg = Join-Path $settingsDir "package.json"
      if ($createdOcPkg) { Remove-Item -LiteralPath $ocPkg -Force -ErrorAction SilentlyContinue }
    }
  }
}
