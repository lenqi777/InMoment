[CmdletBinding()]
param([switch]$CheckOnly)

# This file is copied beside InMoment.exe. It never downloads speech/semantic
# models, records, screenshots, contacts an inference API or installs silently.
$ErrorActionPreference = 'Stop'
# Load Windows PowerShell's own modules even when a parent developer shell has
# passed a PowerShell 7 PSModulePath through cmd.exe or Node.js.
Import-Module -Name (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Import-Module -Name (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$script:InMomentRuntime = @{
    Version = [version]'14.51.36247.0'
    Url = 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe'
    Sha256 = '843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C'
    Bytes = 18731856
    Dlls = @('msvcp140.dll', 'msvcp140_1.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll')
}

function Get-InMomentRuntimeStatus {
    $registeredVersion = $null
    $registryBase = $null
    $runtimeKey = $null
    try {
        $registryBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64)
        $runtimeKey = $registryBase.OpenSubKey('SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64')
        if ($runtimeKey -and $runtimeKey.GetValue('Installed', 0) -eq 1) {
            try { $registeredVersion = [version]([string]$runtimeKey.GetValue('Version', '')).TrimStart('v', 'V') } catch {}
        }
    } finally {
        if ($runtimeKey) { $runtimeKey.Dispose() }
        if ($registryBase) { $registryBase.Dispose() }
    }
    $systemDirectory = Join-Path $env:SystemRoot 'System32'
    if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { $systemDirectory = Join-Path $env:SystemRoot 'Sysnative' }
    $files = foreach ($name in $script:InMomentRuntime.Dlls) {
        $file = Join-Path $systemDirectory $name
        $fileVersion = $null
        if (Test-Path -LiteralPath $file -PathType Leaf) {
            $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
            $fileVersion = [version]('{0}.{1}.{2}.{3}' -f $info.FileMajorPart, $info.FileMinorPart, $info.FileBuildPart, $info.FilePrivatePart)
        }
        [pscustomobject]@{ Name = $name; Version = [string]$fileVersion; Ready = ($null -ne $fileVersion -and $fileVersion -ge $script:InMomentRuntime.Version) }
    }
    [pscustomobject]@{
        Ready = ($null -ne $registeredVersion -and $registeredVersion -ge $script:InMomentRuntime.Version -and @($files | Where-Object { -not $_.Ready }).Count -eq 0)
        RequiredVersion = [string]$script:InMomentRuntime.Version
        RegisteredVersion = [string]$registeredVersion
        Files = @($files)
    }
}

function Read-InMomentYesNo([string]$Message) {
    $answer = Read-Host ($Message + ' [输入 y 同意；直接回车取消 / y or N]')
    return $null -ne $answer -and $answer.Trim() -match '^(?i:y|yes)$'
}

function Assert-InMomentPackage([string]$Directory) {
    foreach ($name in @('InMoment.exe', 'resources/app/build/native/InMoment.Native.exe', 'offline-asr/asr.json', 'offline-asr/bin/whisper-cli.exe', 'offline-asr/models/ggml-base.bin', 'offline-semantic/.inmoment-semantic-model.json', 'offline-semantic/onnx/model_quantized.onnx')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Directory $name) -PathType Leaf)) { throw ('The complete InMoment package is missing: ' + $name + '. Extract the entire release ZIP and retry.') }
    }
}

function Assert-InMomentRuntimeDownload([string]$Filename) {
    if ((Get-Item -LiteralPath $Filename).Length -ne $script:InMomentRuntime.Bytes) { throw 'The Microsoft runtime download has an unexpected size. Nothing was installed.' }
    $actual = (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash
    if ($actual -ine $script:InMomentRuntime.Sha256) { throw 'Microsoft runtime SHA-256 verification failed. Nothing was installed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $Filename
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Microsoft runtime publisher/signature verification failed. Nothing was installed.' }
}

function Get-InMomentRuntimeDownload([string]$Filename) {
    if ($env:INMOMENT_DISABLE_NETWORK -eq '1') { throw 'The development network lock forbids downloads. Nothing was installed.' }
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -Uri $script:InMomentRuntime.Url -OutFile $Filename -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop | Out-Null
    } finally { [Net.ServicePointManager]::SecurityProtocol = $previousProtocol }
    Assert-InMomentRuntimeDownload $Filename
}

function Remove-InMomentInstallerTemp([string]$Directory) {
    # Validate the absolute target and reparse state before any recursive cleanup.
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath($Directory)
    if ([IO.Path]::GetDirectoryName($candidate) -ine $temporaryRoot -or [IO.Path]::GetFileName($candidate) -notmatch '^InMoment-prerequisites-[a-f0-9]{32}$') { throw 'Refusing to clean an unexpected installer directory.' }
    if (Test-Path -LiteralPath $candidate) {
        $item = Get-Item -LiteralPath $candidate -Force
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to clean a linked installer directory.' }
        Remove-Item -LiteralPath $candidate -Recurse -Force
    }
}

function Invoke-InMomentRuntimeInstall {
    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ('InMoment-prerequisites-' + [Guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null
        $installer = Join-Path $temporaryDirectory 'VC_redist.x64.exe'
        Write-Host 'Downloading the pinned Microsoft x64 runtime from download.visualstudio.microsoft.com...'
        Get-InMomentRuntimeDownload $installer
        Write-Host 'SHA-256 and Microsoft publisher signature verified.'
        Write-Host 'The original Microsoft installer will open. Review its license and approve its Windows UAC prompt if requested.'
        # Deliberately preserve the original interactive license/install UI. No
        # /quiet or /passive flags, no bundled Microsoft installer and no reboot.
        $result = Start-Process -FilePath $installer -ArgumentList @('/install', '/norestart') -Wait -PassThru
        $code = [int]$result.ExitCode
        if ($code -eq 3010 -or $code -eq 1641) {
            Write-Host '需要重启：请先保存工作，重启 Windows 后再次运行 Install-InMoment.cmd。'
            return 3010
        }
        if ($code -eq 1602) { throw 'You cancelled the Microsoft installation. InMoment setup was not completed.' }
        if ($code -ne 0 -and $code -ne 1638) { throw ('Microsoft runtime installation did not complete (exit ' + $code + '). See the Microsoft installer message and retry.') }
        $status = Get-InMomentRuntimeStatus
        if (-not $status.Ready) { throw ('The required runtime files are still missing or outdated (installer exit ' + $code + '). Restart Windows, rerun this installer, or repair the Microsoft x64 runtime. Setup was not completed.') }
        return 0
    } finally {
        try { Remove-InMomentInstallerTemp $temporaryDirectory } catch { Write-Warning 'Temporary prerequisite download cleanup failed. It remains in your Windows temporary folder; no user records are stored there.' }
    }
}

function New-InMomentDesktopShortcut([string]$Directory) {
    $desktop = [Environment]::GetFolderPath('DesktopDirectory')
    if (-not $desktop -or -not (Test-Path -LiteralPath $desktop -PathType Container)) { throw 'The current user Desktop directory is unavailable. You can launch InMoment.exe directly.' }
    $filename = Join-Path $desktop 'InMoment.lnk'
    if ((Test-Path -LiteralPath $filename) -and -not (Read-InMomentYesNo '桌面已有 InMoment 快捷方式，是否替换？')) { return }
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($filename)
    $shortcut.TargetPath = Join-Path $Directory 'InMoment.exe'
    $shortcut.WorkingDirectory = $Directory
    $shortcut.IconLocation = (Join-Path $Directory 'InMoment.exe') + ',0'
    $shortcut.Description = 'InMoment - contextual idea capture'
    $shortcut.Save()
    Write-Host '已创建桌面快捷方式。请保留当前解压文件夹的位置，移动文件夹会导致快捷方式失效。'
}

function Invoke-InMomentInstaller([string]$Directory) {
    try {
        $architecture = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
        if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 'AMD64') { throw 'This InMoment package requires an x64 Windows computer.' }
        Assert-InMomentPackage $Directory
        Write-Host ''
        Write-Host 'InMoment 安装引导 - Windows x64'
        Write-Host '离线语音与语义模型已包含，无需安装开发环境或填写路径；此安装过程不需要 API Key。'
        Write-Host '安装过程不会录音、截图、上传资料或调用 AI 模型。'
        $status = Get-InMomentRuntimeStatus
        if (-not $status.Ready) {
            Write-Host ''
            Write-Host ('Whisper and ONNX need Microsoft Visual C++ x64 runtime ' + $status.RequiredVersion + ' or newer.')
            Write-Host '需要补充微软运行库（约 18 MB）。只有你同意后才从微软官网下载，校验后显示微软原厂许可界面与系统授权提示。'
            Write-Host '此步骤需要联网；离线模型无需再次下载。InMoment 不在下载包中附带微软安装器。'
            if (-not (Read-InMomentYesNo '是否从微软官方下载并打开运行库安装程序？')) {
                Write-Host '安装已取消：未下载或安装任何组件。'
                return 1602
            }
            $result = Invoke-InMomentRuntimeInstall
            if ($result -ne 0) { return $result }
        } else { Write-Host '微软运行库已就绪，无需下载或安装其他组件。' }
        Write-Host ''
        if (Read-InMomentYesNo '是否在桌面创建 InMoment 快捷方式？') { New-InMomentDesktopShortcut $Directory }
        Write-Host ''
        Write-Host '安装完成。请打开 InMoment.exe 或桌面快捷方式。'
        Write-Host '如需云端 AI，请在设置中填写你自己的 DeepSeek API Key，并同意所需功能。录音与灵感记录保存在本机用户目录。'
        Write-Host '录音操作、权限、备份与历史版本说明见 docs/USER_GUIDE.md。'
        return 0
    } catch {
        Write-Host ('安装未完成 / SETUP FAILED: ' + $_.Exception.Message) -ForegroundColor Red
        Write-Host '请检查网络与 Windows 提示后重试；不会继续创建快捷方式或启动应用。'
        return 1
    }
}

# Dot-sourcing exposes pure helpers for synthetic/offline tests; it never runs setup.
if ($MyInvocation.InvocationName -ne '.') {
    if ($CheckOnly) { Get-InMomentRuntimeStatus | ConvertTo-Json -Depth 5; exit 0 }
    exit (Invoke-InMomentInstaller $PSScriptRoot)
}
