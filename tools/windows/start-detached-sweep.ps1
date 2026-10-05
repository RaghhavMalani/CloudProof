param(
    [Parameter(Mandatory = $true)][string]$Worktree,
    [Parameter(Mandatory = $true)][string]$Plan,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$DataDir = ""
)
# Starts the interleaved comparison sweep as a detached process that outlives
# the shell that launched it, with its output in <Out>/sweep.log and
# <Out>/sweep.err, plus a keep-awake guard that lasts exactly as long as the
# sweep. Re-running the same command resumes the sweep: recorded trials are
# skipped and the order is unchanged.
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Out | Out-Null
if (-not $DataDir) { $DataDir = Join-Path $Worktree ".bench-data\comparison" }
$node = (Get-Command node).Source
$tool = Join-Path $Worktree "tools\raft-bench-interleaved.js"
$sweep = Start-Process -FilePath $node -WorkingDirectory $Worktree -WindowStyle Hidden -PassThru `
    -ArgumentList @("`"$tool`"", "--plan", "`"$Plan`"", "--out", "`"$Out`"", "--data-dir", "`"$DataDir`"") `
    -RedirectStandardOutput (Join-Path $Out "sweep.log") -RedirectStandardError (Join-Path $Out "sweep.err")
$guard = Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -PassThru `
    -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$(Join-Path $Worktree 'tools\windows\keep-awake-while.ps1')`"", "-WhilePid", $sweep.Id) `
    -RedirectStandardOutput (Join-Path $Out "keep-awake.log")
# The process start time identifies the sweep beyond its pid, which Windows
# can reuse once the sweep has exited (stop-sweep.ps1 checks it).
[pscustomobject]@{ sweepPid = $sweep.Id; sweepStartTime = $sweep.StartTime.ToUniversalTime().ToString("o"); keepAwakePid = $guard.Id; startedAt = (Get-Date).ToString("o"); out = $Out } |
    ConvertTo-Json | Set-Content -Path (Join-Path $Out "launch.json")
"sweep pid $($sweep.Id), keep-awake pid $($guard.Id); log: $(Join-Path $Out 'sweep.log')"
