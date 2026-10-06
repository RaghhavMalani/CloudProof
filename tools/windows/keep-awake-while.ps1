param([int]$WhilePid)
# Keeps the machine from idle-sleeping while process $WhilePid runs, with the
# per-thread request media players use (SetThreadExecutionState
# ES_CONTINUOUS | ES_SYSTEM_REQUIRED). Changes no setting; the request ends
# when this script exits, which it does when $WhilePid exits. A closed lid or
# an explicit Sleep still sleeps.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Awake {
    [DllImport("kernel32.dll")]
    public static extern uint SetThreadExecutionState(uint flags);
}
"@
# Unsigned constants: PowerShell reads 0x80000000 as a negative Int32.
$ES_CONTINUOUS = [uint32]2147483648
$ES_SYSTEM_REQUIRED = [uint32]1
$previous = [Awake]::SetThreadExecutionState([uint32]($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED))
if ($previous -eq 0) { throw "SetThreadExecutionState failed" }
"keep-awake held for pid $WhilePid (previous state 0x{0:X})" -f $previous
try {
    Wait-Process -Id $WhilePid -ErrorAction SilentlyContinue
} finally {
    [void][Awake]::SetThreadExecutionState($ES_CONTINUOUS)
    "keep-awake released"
}
