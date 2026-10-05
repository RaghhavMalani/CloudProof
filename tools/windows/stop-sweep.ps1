param(
    [Parameter(Mandatory = $true)][string]$Out,
    [double]$AfterMinutes = 0
)
# Stops a detached comparison sweep at a trial boundary (methodology
# amendment 3): optionally waits $AfterMinutes, then waits until the trial in
# progress has been appended to <Out>/trials.jsonl, then ends the sweep driver
# and its whole process tree (replicas, load generators) at once. The next
# trial has only just started and records nothing; resuming with
# start-detached-sweep.ps1 continues the same order. Nothing is deleted.
$ErrorActionPreference = "Stop"
$launch = Get-Content -Raw (Join-Path $Out "launch.json") | ConvertFrom-Json
$sweepPid = [int]$launch.sweepPid
$trials = Join-Path $Out "trials.jsonl"

# Windows reuses pids. Only a process that is still the sweep may be stopped:
# its command line runs raft-bench-interleaved.js and, when launch.json
# records it, its start time matches. Checked before waiting and again
# immediately before the kill.
function Test-Sweep {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$sweepPid" -ErrorAction SilentlyContinue
    if (-not $proc) { return "gone" }
    if ($proc.CommandLine -notmatch 'raft-bench-interleaved.js') { return "reused" }
    if ($launch.sweepStartTime) {
        $expected = ([datetime]$launch.sweepStartTime).ToUniversalTime()
        if ([math]::Abs(($proc.CreationDate.ToUniversalTime() - $expected).TotalSeconds) -gt 2) { return "reused" }
    }
    return "sweep"
}

if ($AfterMinutes -gt 0) { Start-Sleep -Seconds ([int]($AfterMinutes * 60)) }
$state = Test-Sweep
if ($state -eq "gone") { "sweep pid $sweepPid is not running"; exit 0 }
if ($state -eq "reused") { "pid $sweepPid now belongs to another process; not stopping it"; exit 1 }
$count = (Get-Content $trials | Measure-Object -Line).Lines
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline -and (Get-Content $trials | Measure-Object -Line).Lines -le $count) { Start-Sleep -Milliseconds 500 }
$after = (Get-Content $trials | Measure-Object -Line).Lines
$state = Test-Sweep
if ($state -ne "sweep") { "sweep pid $sweepPid ended or was reused while waiting ($state); nothing stopped"; exit 0 }
& taskkill.exe /PID $sweepPid /T /F | Out-String | Write-Output
"stopped sweep pid $sweepPid after trial $after (was $count when the stop was requested)"
