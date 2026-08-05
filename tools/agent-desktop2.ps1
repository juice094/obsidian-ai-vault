#Requires -Version 7
# agent-desktop2.ps1
# 把 agent 测试用的 Obsidian 窗口启动/移动到 Windows 第二虚拟桌面，
# 避免干扰用户在桌面1的工作。

param(
    [Parameter(Mandatory = $true)]
    [string]$VaultPath,

    [string]$Executable = "C:\Users\22414\AppData\Local\Programs\Obsidian\Obsidian.exe",

    [ValidateRange(0, 9)]
    [int]$DesktopIndex = 1,

    [int]$LaunchWaitSeconds = 12,

    [switch]$MoveExisting,

    [int]$ProcessId = 0
)

Import-Module VirtualDesktop -ErrorAction Stop

function Ensure-Desktop([int]$index) {
    $count = Get-DesktopCount
    while ($count -le $index) {
        $null = New-Desktop
        $count = Get-DesktopCount
    }
    return Get-Desktop -Index $index
}

function Get-ObsidianWindowHandle([int]$pid, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne 0) {
            return $proc.MainWindowHandle
        }
        Start-Sleep -Milliseconds 300
    }
    return 0
}

$desktop = Ensure-Desktop -index $DesktopIndex

if ($MoveExisting) {
    if ($ProcessId -eq 0) {
        Write-Error "-MoveExisting requires -ProcessId"
        exit 1
    }
    $h = Get-ObsidianWindowHandle -pid $ProcessId -timeoutSec $LaunchWaitSeconds
    if ($h -eq 0) {
        Write-Error "Could not find main window for PID $ProcessId"
        exit 1
    }
    Move-Window -Handle $h -Desktop $desktop
    Write-Output @{ pid = $ProcessId; handle = $h; desktop = $DesktopIndex } | ConvertTo-Json -Compress
    exit 0
}

# Launch new Obsidian window for the test vault.
# --new-window asks Obsidian to open a new window; if the vault is already open,
# it may focus it. Agents must use a dedicated test vault.
$proc = Start-Process -FilePath $Executable -ArgumentList "--vault `"$VaultPath`" --new-window" -PassThru
$h = Get-ObsidianWindowHandle -pid $proc.Id -timeoutSec $LaunchWaitSeconds
if ($h -eq 0) {
    Write-Warning "Main window handle not found yet; process started with PID $($proc.Id)."
    Write-Output @{ pid = $proc.Id; handle = 0; desktop = $DesktopIndex } | ConvertTo-Json -Compress
    exit 0
}

Move-Window -Handle $h -Desktop $desktop
Write-Output @{ pid = $proc.Id; handle = $h; desktop = $DesktopIndex } | ConvertTo-Json -Compress
