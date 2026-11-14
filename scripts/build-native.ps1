param([string]$OutputDirectory)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'The .NET Framework C# compiler is unavailable on this Windows installation.'
}
$outputDir = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $repoRoot 'build\native' }
New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$source = Join-Path $repoRoot 'native\InMoment.Native.cs'
$output = Join-Path $outputDir 'InMoment.Native.exe'
$speechAssembly = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR 'Microsoft.NET\assembly\GAC_MSIL\System.Speech') -Filter System.Speech.dll -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
if (-not $speechAssembly) { throw 'The .NET Framework System.Speech assembly is unavailable.' }
$automationReferences = @('UIAutomationClient', 'UIAutomationTypes', 'WindowsBase') | ForEach-Object {
    $assemblyFile = Get-ChildItem -LiteralPath (Join-Path $env:WINDIR "Microsoft.NET\assembly\GAC_MSIL\$_") -Filter "$_.dll" -Recurse | Select-Object -First 1 -ExpandProperty FullName
    if (-not $assemblyFile) { throw "Missing Windows accessibility assembly: $_" }
    "/reference:$assemblyFile"
}
& $compiler /nologo /target:exe /platform:x64 /optimize+ /warn:4 "/out:$output" /reference:System.dll /reference:System.Core.dll /reference:System.Drawing.dll /reference:System.Windows.Forms.dll /reference:System.Web.Extensions.dll "/reference:$speechAssembly" @automationReferences $source
if ($LASTEXITCODE -ne 0) { throw "Native helper compilation failed ($LASTEXITCODE)." }
Write-Output $output
