param([string]$ProcessIds, [switch]$QueryOnly, [switch]$Reset)
# Opts the given processes out of Windows power throttling (EcoQoS execution
# speed), the per-process switch behind Task Manager's "Efficiency mode", and
# reads the policy back so the caller can verify it took effect. -Reset hands the
# process back to Windows (ControlMask=0: the system decides). Changes no
# system-wide setting. Output, one line per pid:
#   <pid> set=<True|False> read=<True|False> control=<ControlMask> state=<StateMask> error=<Win32 error>
# Applied means read=True with control bit 0x1 set and state bit 0x1 clear.
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
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetProcessInformation(IntPtr process, int infoClass, ref PROCESS_POWER_THROTTLING_STATE info, int size);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    public static string Apply(int pid, bool queryOnly, bool reset) {
        // PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION
        IntPtr h = OpenProcess(0x0200 | 0x1000, false, pid);
        if (h == IntPtr.Zero) return pid + " set=False read=False control=0 state=0 error=" + Marshal.GetLastWin32Error();
        bool set = true;
        int error = 0;
        if (!queryOnly) {
            var s = reset
                ? new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = 0x0, StateMask = 0x0 }  // system-managed (Windows default)
                : new PROCESS_POWER_THROTTLING_STATE { Version = 1, ControlMask = 0x1, StateMask = 0x0 }; // EXECUTION_SPEED: controlled, off
            set = SetProcessInformation(h, 4, ref s, Marshal.SizeOf(s)); // ProcessPowerThrottling
            if (!set) error = Marshal.GetLastWin32Error();
        }
        var q = new PROCESS_POWER_THROTTLING_STATE { Version = 1 };
        bool read = GetProcessInformation(h, 4, ref q, Marshal.SizeOf(q));
        if (!read && error == 0) error = Marshal.GetLastWin32Error();
        CloseHandle(h);
        return pid + " set=" + set + " read=" + read + " control=" + q.ControlMask + " state=" + q.StateMask + " error=" + error;
    }
}
"@
foreach ($id in ($ProcessIds -split ",")) { [PowerThrottle]::Apply([int]$id, [bool]$QueryOnly, [bool]$Reset) }
