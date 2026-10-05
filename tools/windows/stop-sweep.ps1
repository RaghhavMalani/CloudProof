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
if ($AfterMinutes -gt 0) { Start-Sleep -Seconds ([int]($AfterMinutes * 60)) }
if (-not (Get-Process -Id $sweepPid -ErrorAction SilentlyContinue)) { "sweep pid $sweepPid is not running"; exit 0 }
$count = (Get-Content $trials | Measure-Object -Line).Lines
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline -and (Get-Content $trials | Measure-Object -Line).Lines -le $count) { Start-Sleep -Milliseconds 500 }
$after = (Get-Content $trials | Measure-Object -Line).Lines
& taskkill.exe /PID $sweepPid /T /F | Out-String | Write-Output
"stopped sweep pid $sweepPid after trial $after (was $count when the stop was requested)"
