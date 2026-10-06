param(
    [Parameter(Mandatory = $true)][string]$Worktree,
    [Parameter(Mandatory = $true)][string]$Plan,
    [Parameter(Mandatory = $true)][string]$Out,
    [Parameter(Mandatory = $true)][string]$DataDir,
    [int]$BlockMinutes = 60,
    [int]$CooldownMinutes = 20,
    [int]$MaxBlocks = 12
)
# Runs the etcd comparison sweep (methodology amendment 4) in amendment-3
# cool-down blocks, one after another, on the user's instruction of
# 2026-10-05 to start all blocks. It only orchestrates the pinned worktree's
# own tools: start-detached-sweep.ps1 starts or resumes the sweep (recorded
# trials are skipped, the order is unchanged), stop-sweep.ps1 ends it at a
# trial boundary $BlockMinutes after the block started, host-telemetry.ps1
# samples next to each block, and the block's logs are renamed with its
# number. After a fixed $CooldownMinutes the next block resumes. The
# orchestrator stops when the sweep exits by itself (complete, or an error to
# look at) and never reruns a trial. A block that is already running when the
# orchestrator starts (launch.json with a live sweep) is adopted, not
# restarted. The machine is kept awake for the whole run so cool-downs keep
# their length.
#
# Child scripts are started with Start-Process and waited on, never piped:
# the detached sweep inherits inheritable handles, so a pipe to
# start-detached-sweep.ps1 would stay open until the sweep exits.
$ErrorActionPreference = "Stop"
$win = Join-Path $Worktree "tools\windows"
$log = Join-Path $Out "blocks.log"
$launchFile = Join-Path $Out "launch.json"
$trials = Join-Path $Out "trials.jsonl"
function Note($text) { "$((Get-Date).ToUniversalTime().ToString('o')) $text" | Add-Content -Path $log }
function Lines($file) { if (Test-Path $file) { (Get-Content $file | Measure-Object -Line).Lines } else { 0 } }
function Run-Script($script, [string[]]$arguments, $stdout) {
    $all = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$(Join-Path $win $script)`"") + $arguments
    $p = if ($stdout) {
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList $all -RedirectStandardOutput $stdout
    } else {
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru -ArgumentList $all
    }
    $p.WaitForExit()
}
# The sweep named by launch.json, if that process is still the sweep (pid and start time).
function Get-Sweep {
    if (-not (Test-Path $launchFile)) { return $null }
    $launch = Get-Content -Raw $launchFile | ConvertFrom-Json
    $proc = Get-Process -Id ([int]$launch.sweepPid) -ErrorAction SilentlyContinue
    if (-not $proc) { return $null }
    if ([math]::Abs(($proc.StartTime.ToUniversalTime() - ([datetime]$launch.sweepStartTime).ToUniversalTime()).TotalSeconds) -gt 2) { return $null }
    return $proc
}
function Close-Block($n) {
    foreach ($pair in @(@("sweep.log", "sweep-block$n.log"), @("sweep.err", "sweep-block$n.err"),
            @("keep-awake.log", "keep-awake-block$n.log"), @("launch.json", "launch-block$n.json"))) {
        $from = Join-Path $Out $pair[0]
        if (Test-Path $from) { Move-Item -Force $from (Join-Path $Out $pair[1]) }
    }
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null
Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", "`"$(Join-Path $win 'keep-awake-while.ps1')`"", "-WhilePid", $PID) | Out-Null
Note "orchestrator pid ${PID}, worktree $Worktree, plan $Plan, blocks of $BlockMinutes min, cool-down $CooldownMinutes min"

$n = 1
for ($count = 0; $count -lt $MaxBlocks; $count++) {
    while (Test-Path (Join-Path $Out "launch-block$n.json")) { $n++ }
    $sweep = Get-Sweep
    $adopted = [bool]$sweep
    if (-not $sweep -and (Test-Path $launchFile)) {
        Close-Block $n
        Note "block $n had ended without an orchestrator; its logs are kept under block $n"
        $n++
    }
    $before = Lines $trials
    if (-not $sweep) {
        Run-Script "start-detached-sweep.ps1" @("-Worktree", "`"$Worktree`"", "-Plan", "`"$Plan`"", "-Out", "`"$Out`"", "-DataDir", "`"$DataDir`"") $null
        $sweep = Get-Sweep
    }
    $launch = Get-Content -Raw $launchFile | ConvertFrom-Json
    $startedAt = ([datetime]$launch.sweepStartTime).ToUniversalTime()
    Note "block $n $(if ($adopted) { 'adopted (already running)' } else { 'started' }): sweep pid $($launch.sweepPid) since $($startedAt.ToString('o')), $before trials recorded"
    if ($sweep) {
        Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", "`"$(Join-Path $win 'host-telemetry.ps1')`"", "-OutFile", "`"$(Join-Path $Out "host-telemetry-block$n.jsonl")`"",
            "-WhilePid", $sweep.Id) | Out-Null
    }
    $stopped = $false
    if ($sweep) {
        $remainingMs = [math]::Max(0, [int](($startedAt.AddMinutes($BlockMinutes) - (Get-Date).ToUniversalTime()).TotalMilliseconds))
        if (-not $sweep.WaitForExit($remainingMs)) {
            Run-Script "stop-sweep.ps1" @("-Out", "`"$Out`"") (Join-Path $Out "stop-sweep-block$n.log")
            $stopped = $true
            $sweep.WaitForExit(60000) | Out-Null
        }
    }
    Start-Sleep -Seconds 3
    Close-Block $n
    $after = Lines $trials
    Note "block $n ended: $($after - $before) trials this block, $after recorded, $(if ($stopped) { 'stopped at a trial boundary' } else { 'sweep exited by itself' })"
    if (-not $stopped) {
        $err = Join-Path $Out "sweep-block$n.err"
        Note "sweep exited by itself; stderr bytes: $(if (Test-Path $err) { (Get-Item $err).Length } else { 0 }). Orchestrator done."
        break
    }
    $n++
    Note "cool-down $CooldownMinutes min"
    Start-Sleep -Seconds ($CooldownMinutes * 60)
}
Note "orchestrator exit"
