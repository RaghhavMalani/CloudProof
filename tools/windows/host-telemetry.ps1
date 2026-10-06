param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [int]$IntervalSeconds = 5,
    [int]$WhilePid = 0
)
# Read-only host telemetry for the benchmark machine (methodology amendment 3).
# Appends one JSON line every $IntervalSeconds with the processor counters
# Windows exposes without elevation: % Processor Performance (frequency as a
# share of nominal), Processor Frequency (MHz), % Performance Limit (share of
# maximum frequency allowed by power/thermal limits), % Processor Utility and
# % Processor Time. CPU temperature and thermal-zone throttle reasons are not
# exposed on this machine (no thermal-zone instance) and are not recorded.
# Runs until $WhilePid exits (0 = until stopped). It never touches the
# benchmark; trials are joined to it by timestamp afterwards.
$counters = @(
    '\Processor Information(_Total)\% Processor Performance',
    '\Processor Information(_Total)\Processor Frequency',
    '\Processor Information(_Total)\% Performance Limit',
    '\Processor Information(_Total)\% Processor Utility',
    '\Processor Information(_Total)\% Processor Time'
)
$keys = @('processorPerformancePct', 'processorFrequencyMHz', 'performanceLimitPct', 'processorUtilityPct', 'processorTimePct')
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutFile) | Out-Null
# Follow the process, not just its pid: Windows can reuse the number.
$watchedStart = if ($WhilePid -gt 0) { (Get-Process -Id $WhilePid -ErrorAction SilentlyContinue).StartTime } else { $null }
while ($true) {
    if ($WhilePid -gt 0) {
        $watched = Get-Process -Id $WhilePid -ErrorAction SilentlyContinue
        if (-not $watched -or $watched.StartTime -ne $watchedStart) { break }
    }
    try {
        $sample = Get-Counter -Counter $counters -SampleInterval $IntervalSeconds -MaxSamples 1 -ErrorAction Stop
        $row = [ordered]@{ ts = $sample.Timestamp.ToUniversalTime().ToString('o') }
        for ($i = 0; $i -lt $counters.Count; $i++) {
            $match = $sample.CounterSamples | Where-Object { $_.Path -like ('*' + $counters[$i].Substring(1).ToLower()) } | Select-Object -First 1
            $row[$keys[$i]] = if ($match) { [math]::Round($match.CookedValue, 2) } else { $null }
        }
        ($row | ConvertTo-Json -Compress) | Add-Content -Path $OutFile -Encoding utf8
    } catch {
        ([ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); error = $_.Exception.Message } | ConvertTo-Json -Compress) |
            Add-Content -Path $OutFile -Encoding utf8
        Start-Sleep -Seconds $IntervalSeconds
    }
}
