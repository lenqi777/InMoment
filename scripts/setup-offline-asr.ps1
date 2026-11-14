param(
    [string]$RootDir = (Join-Path (Split-Path -Parent $PSScriptRoot) '.local\asr'),
    [string]$NodePath = '',
    [string]$RuntimeArchive = '',
    [string]$ModelArchive = ''
)
# Explicit installation only. The app never invokes this script automatically.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Keep Windows PowerShell modules independent of an inherited PowerShell 7 PSModulePath.
foreach ($module in @('Utility', 'Security', 'Management')) {
    Import-Module -Name (Join-Path $PSHOME ('Modules/Microsoft.PowerShell.' + $module + '/Microsoft.PowerShell.' + $module + '.psd1')) -ErrorAction Stop
}
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$assets = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'asr-assets.json') -Raw | ConvertFrom-Json
$asrRoot = [IO.Path]::GetFullPath($RootDir)
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This offline recognizer requires Windows x64.' }
foreach ($tool in @('curl.exe', 'tar.exe')) { if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw ($tool + ' is required for this explicit setup step.') } }
New-Item -ItemType Directory -Force -Path $asrRoot | Out-Null
if ((Get-Item -LiteralPath $asrRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'The offline installation directory cannot be a link.' }
$downloadDir = Join-Path $asrRoot 'downloads'
New-Item -ItemType Directory -Force -Path $downloadDir | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Get-ChildPath([string]$Parent, [string]$Relative) {
    if ([IO.Path]::IsPathRooted($Relative)) { throw 'Offline component paths must be relative.' }
    $parentPath = [IO.Path]::GetFullPath($Parent)
    $candidate = [IO.Path]::GetFullPath((Join-Path $parentPath $Relative))
    $prefix = $parentPath.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Offline component path escapes its installation directory.' }
    return $candidate
}
function Assert-VerifiedFile([string]$Filename, [long]$Bytes, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Filename -PathType Leaf)) { throw ('Missing offline component: ' + [IO.Path]::GetFileName($Filename)) }
    if ((Get-Item -LiteralPath $Filename).Length -ne $Bytes -or (Get-FileHash -LiteralPath $Filename -Algorithm SHA256).Hash -ine $Sha256) { throw ('Offline component SHA-256 or size verification failed: ' + [IO.Path]::GetFileName($Filename)) }
}
function Get-VerifiedArchive($Spec, [string]$Provided) {
    if ($Provided) { $providedPath = [IO.Path]::GetFullPath($Provided); Assert-VerifiedFile $providedPath $Spec.bytes $Spec.sha256; return $providedPath }
    $destination = Get-ChildPath $downloadDir $Spec.filename
    if (Test-Path -LiteralPath $destination -PathType Leaf) { try { Assert-VerifiedFile $destination $Spec.bytes $Spec.sha256; return $destination } catch {} }
    if ($env:INMOMENT_DISABLE_NETWORK -eq '1') { throw 'The development network lock forbids component downloads.' }
    $partialPath = $destination + '.part'
    & curl.exe --location --fail --silent --show-error --connect-timeout 15 --max-time 900 --speed-time 30 --speed-limit 1024 --retry 3 --retry-delay 2 --output $partialPath $Spec.url
    if ($LASTEXITCODE -ne 0) { throw 'An offline speech component download failed. Run this explicit setup again to retry.' }
    Assert-VerifiedFile $partialPath $Spec.bytes $Spec.sha256
    Move-Item -LiteralPath $partialPath -Destination $destination -Force
    return $destination
}
function Copy-VerifiedFile([string]$Source, [string]$Target, $Spec) {
    Assert-VerifiedFile $Source $Spec.bytes $Spec.sha256
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($Target)) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $Target -Force
    Assert-VerifiedFile $Target $Spec.bytes $Spec.sha256
}

Write-Output 'Preparing sherpa-onnx 2.0.1 Windows CPU runtime and SenseVoiceSmall INT8 2024-07-17 (model about 228 MiB).'
Write-Output 'Only public runtime/model files are downloaded. Audio stays local; no model inference is started.'
$runtimeArchivePath = Get-VerifiedArchive $assets.runtimeArchive $RuntimeArchive
$modelArchivePath = Get-VerifiedArchive $assets.modelArchive $ModelArchive
$stagingDir = Get-ChildPath $asrRoot ('.setup-' + [Guid]::NewGuid().ToString('N'))
$preparedDir = Get-ChildPath $stagingDir 'prepared'
$extractedDir = Get-ChildPath $stagingDir 'extracted'
try {
    New-Item -ItemType Directory -Force -Path $preparedDir,$extractedDir | Out-Null
    # Extract only fixed allowlisted entries from the hash-verified archives.
    foreach ($kind in @('runtime', 'model')) {
        $archiveSpec = if ($kind -eq 'runtime') { $assets.runtimeArchive } else { $assets.modelArchive }
        $archivePath = if ($kind -eq 'runtime') { $runtimeArchivePath } else { $modelArchivePath }
        $entries = @($assets.files | Where-Object { $_.archive -eq $kind } | ForEach-Object { $archiveSpec.directory + '/' + $_.entry })
        & tar.exe -xf $archivePath -C $extractedDir @entries
        if ($LASTEXITCODE -ne 0) { throw 'Could not extract the verified offline component archive.' }
    }
    $documents = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\third-party'
    foreach ($file in $assets.files) {
        if ($file.archive) {
            $archiveSpec = if ($file.archive -eq 'runtime') { $assets.runtimeArchive } else { $assets.modelArchive }
            $source = Get-ChildPath $extractedDir ($archiveSpec.directory + '/' + $file.entry)
        } else { $source = Get-ChildPath $documents $file.document }
        Copy-VerifiedFile $source (Get-ChildPath $preparedDir $file.path) $file
    }
    # Preserve the prior installation; existing legacy files also remain in place.
    # Packaging copies only the new allowlist, excluding these backups.
    $oldManifestPath = Join-Path $asrRoot 'asr.json'
    if (Test-Path -LiteralPath $oldManifestPath -PathType Leaf) {
        $previous = $null
        try { $previous = Get-Content -LiteralPath $oldManifestPath -Raw | ConvertFrom-Json } catch {}
        if (-not $previous -or $previous.provider -ne $assets.provider -or $previous.version -ne $assets.version -or $previous.modelRevision -ne $assets.modelRevision) {
            $backup = Get-ChildPath $asrRoot ('backups/upgrade-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Force -Path $backup | Out-Null
            foreach ($name in @('asr.json', 'PROVENANCE.json', 'bin', 'models', 'WHISPER-CPP-LICENSE.txt', 'WHISPER-MODEL-LICENSE.txt')) {
                $existing = Get-ChildPath $asrRoot $name
                if (Test-Path -LiteralPath $existing) { Copy-Item -LiteralPath $existing -Destination (Join-Path $backup $name) -Recurse -Force }
            }
            Write-Output ('Previous offline installation backed up: ' + $backup)
        }
    }
    foreach ($file in $assets.files) { Copy-VerifiedFile (Get-ChildPath $preparedDir $file.path) (Get-ChildPath $asrRoot $file.path) $file }
    $manifest = [ordered]@{
        schemaVersion = 2
        provider = $assets.provider; version = $assets.version; model = $assets.model
        modelRevision = $assets.modelRevision; precision = $assets.precision
        binaryPath = $assets.binaryPath; modelPath = $assets.modelPath; tokensPath = $assets.tokensPath
        runtimeFiles = @('bin/onnxruntime.dll', 'bin/onnxruntime_providers_shared.dll')
        modelSha256 = ($assets.files | Where-Object { $_.path -eq $assets.modelPath }).sha256
        tokensSha256 = ($assets.files | Where-Object { $_.path -eq $assets.tokensPath }).sha256
        binaryArchiveUrl = $assets.runtimeArchive.url; binaryArchiveSha256 = $assets.runtimeArchive.sha256
        modelArchiveUrl = $assets.modelArchive.url; modelArchiveSha256 = $assets.modelArchive.sha256
        installedAt = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $asrRoot 'PROVENANCE.json'), ($assets | ConvertTo-Json -Depth 8), $utf8)
    $pendingManifest = Get-ChildPath $asrRoot ('asr.json.pending-' + [Guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText($pendingManifest, ($manifest | ConvertTo-Json -Depth 6), $utf8)
    Move-Item -LiteralPath $pendingManifest -Destination (Join-Path $asrRoot 'asr.json') -Force
    Write-Output ('SenseVoiceSmall offline recognizer installed: ' + $asrRoot)
    Write-Output 'No Python, microphone, screen, recording, or model API was used. Keep the supplied runtime and model licenses when redistributing.'
}
finally {
    # Verify the absolute cleanup target is inside this explicitly named installation.
    $resolvedStaging = [IO.Path]::GetFullPath($stagingDir)
    $allowedPrefix = $asrRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolvedStaging.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStaging)) {
        if ((Get-Item -LiteralPath $resolvedStaging -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing to remove linked setup staging.' }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
}

