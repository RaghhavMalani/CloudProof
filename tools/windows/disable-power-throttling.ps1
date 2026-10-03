param([string]$ProcessIds)
# Opts the given processes out of Windows power throttling (EcoQoS execution
# speed), the per-process switch behind Task Manager's "Efficiency mode".
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PowerThrottle {
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_POWER_THROTTLING_STATE { public uint Version; public uint ControlMask; public uint StateMask; }
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    public static bool Disable(int pid) {
        IntPtr h = OpenProcess(0x0200, false, pid); // PROCESS_SET_INFORMATION
        if (h == IntPtr.Zero) return false;
        var s = new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = 0x1, StateMask = 0x0 }; // EXECUTION_SPEED: controlled, off
        bool ok = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(s)); // ProcessPowerThrottling
        CloseHandle(h);
        return ok;
    }
}
"@
foreach ($id in ($ProcessIds -split ",")) { "{0} {1}" -f $id, [PowerThrottle]::Disable([int]$id) }
