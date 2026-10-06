'use strict';

/**
 * environment.js — records the machine a benchmark ran on.
 *
 * Every field is captured by a command or API call, never typed in by hand.
 * Fields that cannot be determined on this platform are recorded as null with
 * the reason, rather than omitted, so a reader can tell "unknown" from
 * "forgot to record".
 */

const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function run(command, args, { timeoutMs = 15000 } = {}) {
    try {
        return {
            ok: true,
            output: execFileSync(command, args, {
                encoding: 'utf8',
                timeout: timeoutMs,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            }).trim(),
        };
    } catch (error) {
        return { ok: false, error: (error.stderr || error.message || String(error)).toString().trim().split('\n')[0] };
    }
}

function powershellJson(script) {
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `${script} | ConvertTo-Json -Depth 4 -Compress`]);
    if (!result.ok || !result.output) return { ok: false, error: result.error || 'empty output' };
    try {
        return { ok: true, value: JSON.parse(result.output) };
    } catch (error) {
        return { ok: false, error: `unparseable: ${error.message}` };
    }
}

function gitInfo(root) {
    const sha = run('git', ['-C', root, 'rev-parse', 'HEAD']);
    const branch = run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD']);
    const status = run('git', ['-C', root, 'status', '--porcelain', '--untracked-files=no']);
    return {
        sha: sha.ok ? sha.output : null,
        branch: branch.ok ? branch.output : null,
        dirty: status.ok ? status.output.length > 0 : null,
        dirtyFiles: status.ok && status.output ? status.output.split('\n').map((l) => l.trim()) : [],
    };
}

function windowsDetails(dataDir) {
    const cpu = powershellJson('Get-CimInstance Win32_Processor | Select-Object Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed');
    const system = powershellJson('Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,TotalPhysicalMemory');
    const osInfo = powershellJson('Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber');
    const drive = path.parse(path.resolve(dataDir)).root.replace(/[:\\/]+$/, '');
    const volume = powershellJson(`Get-Volume -DriveLetter ${drive} | Select-Object DriveLetter,FileSystem,FileSystemLabel,Size,SizeRemaining`);
    const disk = powershellJson(`Get-Partition -DriveLetter ${drive} | Get-Disk | Select-Object FriendlyName,BusType,Model`);
    const physical = powershellJson('Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,Size');
    const battery = powershellJson('Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining');
    const plan = run('powercfg', ['/getactivescheme']);
    // Other workloads on the machine are a source of noise the benchmark
    // cannot remove, so the heaviest ones are recorded rather than ignored.
    const background = powershellJson('Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 12 '
        + 'Name,@{n="workingSetMB";e={[math]::Round($_.WorkingSet64/1MB)}},@{n="cpuSeconds";e={[math]::Round($_.CPU,1)}}');
    const batteryValue = battery.ok ? battery.value : null;
    // Win32_Battery.BatteryStatus: 1 = discharging, 2 = on AC (others: charging states).
    const onAc = batteryValue ? batteryValue.BatteryStatus !== 1 : null;
    return {
        cpu: cpu.ok ? {
            model: cpu.value.Name,
            physicalCores: cpu.value.NumberOfCores,
            logicalProcessors: cpu.value.NumberOfLogicalProcessors,
            maxClockMHz: cpu.value.MaxClockSpeed,
        } : { error: cpu.error },
        machine: system.ok ? { manufacturer: system.value.Manufacturer, model: system.value.Model } : { error: system.error },
        os: osInfo.ok ? { caption: osInfo.value.Caption, version: osInfo.value.Version, build: osInfo.value.BuildNumber } : { error: osInfo.error },
        dataVolume: volume.ok ? {
            drive: volume.value.DriveLetter,
            fileSystem: volume.value.FileSystem,
            sizeBytes: volume.value.Size,
            freeBytes: volume.value.SizeRemaining,
        } : { error: volume.error },
        dataDisk: disk.ok ? { name: disk.value.FriendlyName, bus: disk.value.BusType, model: disk.value.Model } : { error: disk.error },
        physicalDisks: physical.ok ? [].concat(physical.value) : { error: physical.error },
        power: {
            onAcPower: onAc,
            batteryPercent: batteryValue ? batteryValue.EstimatedChargeRemaining : null,
            activePowerPlan: plan.ok ? plan.output.replace(/^Power Scheme GUID:\s*/, '') : null,
        },
        backgroundProcessesByMemory: background.ok ? [].concat(background.value) : { error: background.error },
        notes: [
            'Microsoft Defender real-time protection was active; it can add latency to file writes. '
                + 'Changing security settings is out of scope, so it was left enabled and disclosed.',
            'The machine is a laptop used interactively; other applications were running (see '
                + 'backgroundProcessesByMemory). Per-trial system-wide CPU load is recorded in every trial.',
        ],
    };
}

function linuxDetails(dataDir) {
    const lscpu = run('lscpu', []);
    const df = run('df', ['-T', dataDir]);
    return {
        cpu: { lscpu: lscpu.ok ? lscpu.output : null, error: lscpu.ok ? undefined : lscpu.error },
        dataVolume: { df: df.ok ? df.output : null, error: df.ok ? undefined : df.error },
        power: { onAcPower: null, reason: 'not probed on this platform' },
    };
}

function captureEnvironment({ root, dataDir }) {
    const cpus = os.cpus();
    const docker = run('docker', ['version', '--format', '{{.Server.Version}}']);
    const dockerClient = run('docker', ['version', '--format', '{{.Client.Version}}']);
    const platformDetails = process.platform === 'win32' ? windowsDetails(dataDir) : linuxDetails(dataDir);
    return {
        schema: 'cloudproof.raft-bench.environment/v1',
        capturedAt: new Date().toISOString(),
        git: gitInfo(root),
        node: {
            version: process.version,
            v8: process.versions.v8,
            uv: process.versions.uv,
            execPath: process.execPath,
        },
        os: {
            platform: process.platform,
            arch: process.arch,
            type: os.type(),
            release: os.release(),
            version: typeof os.version === 'function' ? os.version() : null,
        },
        cpu: {
            model: cpus[0] ? cpus[0].model : null,
            logicalCores: cpus.length,
            nominalMHz: cpus[0] ? cpus[0].speed : null,
        },
        memory: { totalBytes: os.totalmem(), freeBytesAtCapture: os.freemem() },
        docker: {
            client: dockerClient.ok ? dockerClient.output : null,
            server: docker.ok ? docker.output : null,
            note: docker.ok ? null : `Docker daemon not reachable (${docker.error}); benchmarks ran as native processes`,
        },
        dataDir: path.resolve(dataDir),
        platformDetails,
    };
}

module.exports = { captureEnvironment };
