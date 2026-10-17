param(
    [string]$RootDir = (Join-Path (Split-Path -Parent $PSScriptRoot) '.local\asr'),
    [string]$NodePath = ''
)

# This script is an explicit, user-initiated installation step. The app never runs it automatically.
# Sources: ggml-org/whisper.cpp v1.9.5 links its official binary build b5454.
# https://github.com/ggml-org/whisper.cpp/releases/expanded_assets/b5454
# https://github.com/ggml-org/whisper.cpp/blob/v1.9.5/models/README.md
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$asrRoot = [IO.Path]::GetFullPath($RootDir)
$binaryUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
$binarySha256 = '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb'
$modelUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin?download=true'
$modelSha1 = '465707469ff3a37a2b9b8d8f89f2f99de7299dac'
if (-not [Environment]::Is64BitOperatingSystem) { throw 'This offline recognizer requires Windows x64.' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'Windows curl.exe is required for this explicit setup step.' }
New-Item -ItemType Directory -Force -Path $asrRoot | Out-Null
$downloadDir = Join-Path $asrRoot 'downloads'
$modelDir = Join-Path $asrRoot 'models'
$binaryDir = Join-Path $asrRoot 'bin'
New-Item -ItemType Directory -Force -Path $downloadDir,$modelDir,$binaryDir | Out-Null

function Get-VerifiedDownload([string]$Url, [string]$Destination, [string]$Algorithm, [string]$ExpectedHash) {
    if ((Test-Path -LiteralPath $Destination) -and ((Get-FileHash -LiteralPath $Destination -Algorithm $Algorithm).Hash -ieq $ExpectedHash)) {
        return
    }
    $partialPath = $Destination + '.part'
    & curl.exe --location --fail --silent --show-error --connect-timeout 15 --max-time 900 --speed-time 30 --speed-limit 1024 --retry 3 --retry-delay 2 --output $partialPath $Url
    if ($LASTEXITCODE -ne 0) { throw 'An offline speech component download failed. Run this setup script again to retry.' }
    $actualHash = (Get-FileHash -LiteralPath $partialPath -Algorithm $Algorithm).Hash
    if ($actualHash -ine $ExpectedHash) {
        Remove-Item -LiteralPath $partialPath -Force
        throw "Offline component integrity verification failed ($Algorithm). Nothing was installed from that download."
    }
    Move-Item -LiteralPath $partialPath -Destination $Destination -Force
}

Write-Output 'Downloading official whisper.cpp Windows CPU build and multilingual base model (142 MiB).'
$archive = Join-Path $downloadDir 'whisper-b5454-bin-x64.zip'
Get-VerifiedDownload $binaryUrl $archive 'SHA256' $binarySha256
if (-not $NodePath) { $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue; if ($nodeCommand) { $NodePath = $nodeCommand.Source } }
if ($NodePath -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'download-model.cjs'))) {
    & $NodePath (Join-Path $PSScriptRoot 'download-model.cjs') $asrRoot
    if ($LASTEXITCODE -ne 0) { throw 'Offline model range download failed. Rerun this explicit setup step to resume.' }
} else {
    Get-VerifiedDownload $modelUrl (Join-Path $modelDir 'ggml-base.bin') 'SHA1' $modelSha1
}
$stagingDir = Join-Path $asrRoot ('.setup-' + [Guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $archive -DestinationPath $stagingDir -Force
    $cli = Get-ChildItem -LiteralPath $stagingDir -Recurse -File -Filter 'whisper-cli.exe' | Select-Object -First 1
    if (-not $cli) { throw 'The verified archive does not contain whisper-cli.exe.' }
    Get-ChildItem -LiteralPath $cli.DirectoryName -Force | Copy-Item -Destination $binaryDir -Recurse -Force
    $mitBody = @'
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'@
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $asrRoot 'WHISPER-CPP-LICENSE.txt'), "MIT License`r`n`r`nCopyright (c) 2023-2026 The ggml authors`r`n`r`n$mitBody`r`n", $utf8)
    [IO.File]::WriteAllText((Join-Path $asrRoot 'WHISPER-MODEL-LICENSE.txt'), "MIT License`r`n`r`nCopyright (c) 2022 OpenAI`r`n`r`n$mitBody`r`n", $utf8)
    $manifest = [ordered]@{
        provider = 'whisper.cpp'; version = '1.9.5'; buildTag = 'b5454'; model = 'base'
        binaryPath = 'bin/whisper-cli.exe'; modelPath = 'models/ggml-base.bin'
        binaryArchiveUrl = $binaryUrl; binaryArchiveSha256 = $binarySha256
        modelUrl = $modelUrl; modelSha1 = $modelSha1
        installedAt = [DateTime]::UtcNow.ToString('o')
    }
    [IO.File]::WriteAllText((Join-Path $asrRoot 'asr.json'), ($manifest | ConvertTo-Json), $utf8)
    Write-Output ('Offline recognizer installed: ' + $asrRoot)
    Write-Output 'No microphone, screen, recording, or model API was accessed. Keep both MIT license notices when redistributing these components.'
}
finally {
    # Validate the resolved deletion target before recursive cleanup on Windows.
    $resolvedStaging = [IO.Path]::GetFullPath($stagingDir)
    $allowedPrefix = $asrRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($resolvedStaging.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedStaging)) {
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
    }
}
