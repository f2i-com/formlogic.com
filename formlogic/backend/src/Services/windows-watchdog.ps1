# Own exactly one retained process handle. Never reopen a PID or launch a killer.
# READY does not authorize termination: only ARM from the PHP owner does that.
# After the first ARM, EOF, CANCEL and every internal failure stop this target.
param([string] $TargetPid, [string] $AckPath)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$script:target = $null
$script:retainedHandle = $null
$script:authorized = $false
$script:result = 70
$script:ackStream = $null
$script:nonce = ''

function Write-Acknowledgment([string] $text) {
    if ($null -eq $script:ackStream) {
        # Create once and keep the write handle. Existing/spoofed ACK paths fail
        # before ARM is read; sharing allows PHP reads, never another writer/delete.
        $script:ackStream = [IO.FileStream]::new($AckPath, [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::Read)
    }
    $bytes = [Text.Encoding]::ASCII.GetBytes($script:nonce + ' ' + $text + "`n")
    $script:ackStream.SetLength(0)
    [void] $script:ackStream.Seek(0, [IO.SeekOrigin]::Begin)
    $script:ackStream.Write($bytes, 0, $bytes.Length)
    $script:ackStream.Flush($true)
}

function Stop-OwnedTarget {
    try {
        if ($script:target.get_HasExited()) { return 0 }
        # SafeHandle was acquired and remains cached on this same Process.
        # Parameterless Kill uses that handle in Windows .NET Framework too.
        $script:target.Kill()
        if (-not $script:target.WaitForExit(2000)) { return 42 }
        return 0
    } catch {
        try { if ($script:target.get_HasExited()) { return 0 } } catch {}
        return 41
    }
}

function Invoke-Watchdog {
    [int] $targetNumber = 0
    if ($args.Count -ne 0 -or
        -not [int]::TryParse($TargetPid, [ref] $targetNumber) -or $targetNumber -le 0 -or
        [string]::IsNullOrWhiteSpace($AckPath) -or $AckPath -notmatch '\A[A-Za-z]:[\\/]' -or
        $AckPath.IndexOf(':', 2) -ge 0 -or
        -not [IO.Directory]::Exists([IO.Path]::GetDirectoryName($AckPath)) -or
        [IO.File]::Exists($AckPath) -or [IO.Directory]::Exists($AckPath)) { return 10 }

    try {
        $script:target = [Diagnostics.Process]::GetProcessById($targetNumber)
        $script:retainedHandle = $script:target.get_SafeHandle()
        if ($script:retainedHandle.get_IsInvalid() -or $script:retainedHandle.get_IsClosed() -or
            $script:target.get_HasExited()) { return 20 }
    } catch { return 20 }

    $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(),
        [Text.Encoding]::ASCII, $false, 128, $true)
    # HELLO is not kill authorization. It binds the acknowledgment to this exact
    # control pipe; fixed PID/sequence files cannot spoof successful acquisition.
    $helloRead = $reader.ReadLineAsync()
    if (-not $helloRead.Wait(5000)) { return 30 }
    $hello = $helloRead.GetAwaiter().GetResult()
    if ($null -eq $hello -or $hello -cnotmatch '\AHELLO ([0-9a-f]{64})\z') { return 32 }
    $script:nonce = $Matches[1]
    # PHP still owns its original process resource when it accepts READY.
    Write-Acknowledgment ('0 READY ' + $TargetPid)
    $pending = $reader.ReadLineAsync()
    $clock = [Diagnostics.Stopwatch]::StartNew()
    [double] $deadline = 5000 # bounded initial ARM wait; no kill before authorization
    [long] $sequence = 0
    $computing = $false

    while ($true) {
        if ($script:target.get_HasExited()) { return 0 }
        # Check the deadline before a PAUSE can acknowledge an already expired window.
        if (($computing -or -not $script:authorized) -and $clock.ElapsedMilliseconds -ge $deadline) {
            return 30
        }
        if ($pending.IsCompleted) {
            $line = $pending.GetAwaiter().GetResult()
            if ($null -eq $line) { return 31 }
            if ($line -cnotmatch '\A([1-9][0-9]{0,8}) (ARM ([1-9][0-9]{0,18})|PAUSE|CANCEL)\z') { return 32 }
            $next = [long] $Matches[1]
            $command = [string] $Matches[2]
            if ($next -ne $sequence + 1) { return 33 }
            $sequence = $next
            if ($command -eq 'CANCEL') { return 0 }
            if ($command -eq 'PAUSE') {
                if (-not $script:authorized -or -not $computing) { return 34 }
                $computing = $false
                if ($script:target.get_HasExited()) { return 0 }
                Write-Acknowledgment ($sequence.ToString() + ' PAUSED ' + $TargetPid)
            } else {
                if ($computing) { return 34 }
                $seconds = [long] $Matches[3]
                # Every earlier branch is non-killing. This exact ARM authorizes
                # only the handle acquired before READY, even if PHP now dies.
                $script:authorized = $true
                $deadline = $clock.ElapsedMilliseconds + ([double] $seconds * 1000)
                $computing = $true
                if ($script:target.get_HasExited()) { return 0 }
                Write-Acknowledgment ($sequence.ToString() + ' ARMED ' + $TargetPid)
            }
            $pending = $reader.ReadLineAsync()
        }
        [Threading.Thread]::Sleep(10)
    }
}

try {
    if ($args.Count -ne 0) { $script:result = 10 }
    else { $script:result = Invoke-Watchdog }
} catch { $script:result = 40 }
finally {
    # Includes owner EOF while paused, final CANCEL and every post-ARM error.
    if ($script:authorized -and $null -ne $script:target) {
        $cleanup = Stop-OwnedTarget
        if ($cleanup -ne 0) { $script:result = $cleanup }
    }
    if ($null -ne $script:target) { $script:target.Dispose() }
    if ($null -ne $script:ackStream) { $script:ackStream.Dispose() }
}
exit $script:result
