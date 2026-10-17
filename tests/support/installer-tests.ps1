param([Parameter(Mandatory = $true)][string]$InstallerScript)
$ErrorActionPreference = 'Stop'
. $InstallerScript

# All integration boundaries are inert, including installer UI, downloads and
# shortcuts. Nothing in this harness starts an app, downloads or changes Windows.
function Invoke-WebRequest { throw 'Real network is forbidden by the installer test harness.' }
function Start-Process { throw 'Real process launch is forbidden by the installer test harness.' }
function Read-Host { throw 'Unexpected interactive input in the installer test harness.' }
function Write-Host { }
function Write-Warning { }
function Assert-InMomentPackage { }
function New-InMomentDesktopShortcut { throw 'Real shortcuts are forbidden by the installer test harness.' }

$script:passed = 0
$script:failures = @()
function Assert-Installer($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Assert-InstallerThrows([scriptblock]$Action, [string]$Message) {
    $thrown = $false
    try { & $Action } catch { $thrown = $true; Assert-Installer ($_.Exception.Message -match $Message) ('Unexpected error: ' + $_.Exception.Message) }
    Assert-Installer $thrown 'Expected a rejected operation.'
}
function Test-Installer([string]$Name, [scriptblock]$Action) {
    try { & $Action; $script:passed++ } catch { $script:failures += ($Name + ': ' + $_.Exception.Message) }
}

Test-Installer 'ready runtime needs no download' {
    function Get-InMomentRuntimeStatus { [pscustomobject]@{ Ready = $true; RequiredVersion = '14.51.36247.0' } }
    function Read-InMomentYesNo { $false }
    function Invoke-InMomentRuntimeInstall { throw 'Should not install a ready runtime.' }
    Assert-Installer ((Invoke-InMomentInstaller 'synthetic-package') -eq 0) 'Ready runtime setup failed.'
}
Test-Installer 'declining prerequisite never installs' {
    function Get-InMomentRuntimeStatus { [pscustomobject]@{ Ready = $false; RequiredVersion = '14.51.36247.0' } }
    function Read-InMomentYesNo { $false }
    function Invoke-InMomentRuntimeInstall { throw 'Should not install without consent.' }
    Assert-Installer ((Invoke-InMomentInstaller 'synthetic-package') -eq 1602) 'Declining setup did not cancel.'
}
Test-Installer 'network lock rejects download before transport' {
    Assert-InstallerThrows { Get-InMomentRuntimeDownload 'never-created.exe' } 'network lock'
}

foreach ($exitCode in @(0, 1638, 3010, 1641)) {
    $script:syntheticExitCode = $exitCode
    Test-Installer ('installer exit ' + $exitCode) {
        function Get-InMomentRuntimeDownload { }
        function Start-Process { [pscustomobject]@{ ExitCode = $script:syntheticExitCode } }
        function Get-InMomentRuntimeStatus { [pscustomobject]@{ Ready = $true } }
        $expected = if ($script:syntheticExitCode -eq 3010 -or $script:syntheticExitCode -eq 1641) { 3010 } else { 0 }
        Assert-Installer ((Invoke-InMomentRuntimeInstall) -eq $expected) 'Unexpected handling of installer exit code.'
    }
}
Test-Installer 'user cancellation stays visible' {
    function Get-InMomentRuntimeDownload { }
    function Start-Process { [pscustomobject]@{ ExitCode = 1602 } }
    Assert-InstallerThrows { Invoke-InMomentRuntimeInstall } 'cancelled'
}
Test-Installer 'unrecognized installer failure stops' {
    function Get-InMomentRuntimeDownload { }
    function Start-Process { [pscustomobject]@{ ExitCode = 5 } }
    Assert-InstallerThrows { Invoke-InMomentRuntimeInstall } 'exit 5'
}
Test-Installer 'success exit still requires runtime recheck' {
    function Get-InMomentRuntimeDownload { }
    function Start-Process { [pscustomobject]@{ ExitCode = 0 } }
    function Get-InMomentRuntimeStatus { [pscustomobject]@{ Ready = $false } }
    Assert-InstallerThrows { Invoke-InMomentRuntimeInstall } 'still missing'
}
Test-Installer '1638 does not hide missing runtime files' {
    function Get-InMomentRuntimeDownload { }
    function Start-Process { [pscustomobject]@{ ExitCode = 1638 } }
    function Get-InMomentRuntimeStatus { [pscustomobject]@{ Ready = $false } }
    Assert-InstallerThrows { Invoke-InMomentRuntimeInstall } 'still missing'
}
Test-Installer 'cleanup rejects arbitrary directories' {
    Assert-InstallerThrows { Remove-InMomentInstallerTemp ([IO.Path]::GetTempPath()) } 'unexpected installer directory'
}

$fixtureDirectory = Join-Path ([IO.Path]::GetTempPath()) ('InMoment-prerequisites-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
try {
    $fixtureFile = Join-Path $fixtureDirectory 'synthetic.bin'
    [IO.File]::WriteAllBytes($fixtureFile, [Text.Encoding]::UTF8.GetBytes('inert installer test bytes'))
    $script:InMomentRuntime.Bytes = (Get-Item -LiteralPath $fixtureFile).Length
    $script:InMomentRuntime.Sha256 = (Get-FileHash -LiteralPath $fixtureFile -Algorithm SHA256).Hash
    Test-Installer 'synthetic trusted digest and publisher accepted' {
        function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Microsoft Corporation, O=Microsoft Corporation, C=US' } } }
        Assert-InMomentRuntimeDownload $fixtureFile
    }
    Test-Installer 'invalid signature rejected' {
        function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'HashMismatch'; SignerCertificate = $null } }
        Assert-InstallerThrows { Assert-InMomentRuntimeDownload $fixtureFile } 'signature verification failed'
    }
    Test-Installer 'other publisher rejected' {
        function Get-AuthenticodeSignature { [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=Synthetic, O=Other Publisher, C=US' } } }
        Assert-InstallerThrows { Assert-InMomentRuntimeDownload $fixtureFile } 'signature verification failed'
    }
    Test-Installer 'digest mismatch rejected before signature' {
        function Get-AuthenticodeSignature { throw 'Signature check should not be reached.' }
        $script:InMomentRuntime.Sha256 = '0' * 64
        Assert-InstallerThrows { Assert-InMomentRuntimeDownload $fixtureFile } 'SHA-256 verification failed'
    }
    Test-Installer 'size mismatch rejected before signature' {
        function Get-AuthenticodeSignature { throw 'Signature check should not be reached.' }
        $script:InMomentRuntime.Bytes++
        Assert-InstallerThrows { Assert-InMomentRuntimeDownload $fixtureFile } 'unexpected size'
    }
} finally { Remove-InMomentInstallerTemp $fixtureDirectory }

[pscustomobject]@{ passed = $script:passed; failed = $script:failures.Count; failures = @($script:failures); realDownloads = 0; realInstallations = 0; realShortcuts = 0 } | ConvertTo-Json -Depth 4 -Compress
if ($script:failures.Count) { exit 1 }
