[CmdletBinding()]
param(
    [string]$SdkRoot,
    [string]$JavaHome,
    [string]$OutputDirectory,
    [string]$KeystorePath
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-AndroidTool {
    param([string]$Tool, [string[]]$Arguments)

    & $Tool @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "$(Split-Path -Leaf $Tool) exited with code $LASTEXITCODE."
    }
}

$previewRoot = Join-Path $env:LOCALAPPDATA 'SmartCart\AndroidPreview'
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $previewRoot 'build'
}
if (-not $KeystorePath) {
    $KeystorePath = Join-Path $previewRoot 'debug.keystore'
}
$OutputDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$KeystorePath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($KeystorePath)

if (-not $JavaHome) {
    $javac = Get-Command javac.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    $vsJdkDirectory = Join-Path $env:ProgramFiles 'Android\openjdk'
    $JavaHome = @(
        $env:JAVA_HOME
        if ($javac) { Split-Path -Parent (Split-Path -Parent $javac.Source) }
        Get-ChildItem -LiteralPath $vsJdkDirectory -Directory -ErrorAction SilentlyContinue |
            Where-Object Name -match '^jdk-(\d+)' |
            Sort-Object { [int]($_.Name -replace '^jdk-(\d+).*', '$1') } -Descending |
            ForEach-Object FullName
        (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr')
    ) | Where-Object {
        $_ -and (Test-Path -LiteralPath (Join-Path $_ 'bin\javac.exe') -PathType Leaf) -and
            (Test-Path -LiteralPath (Join-Path $_ 'bin\keytool.exe') -PathType Leaf)
    } | Select-Object -First 1
}
if (-not $JavaHome -or
    -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\javac.exe') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin\keytool.exe') -PathType Leaf)) {
    throw 'Java JDK not found. Set JAVA_HOME or pass -JavaHome with JDK 17 or newer.'
}
$JavaHome = (Resolve-Path -LiteralPath $JavaHome).Path

$sdkCandidates = if ($SdkRoot) {
    $SdkRoot
} else {
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $env:ANDROID_HOME
    $env:ANDROID_SDK_ROOT
    (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
    if ($programFilesX86) { Join-Path $programFilesX86 'Android\android-sdk' }
}
$requiredTools = 'aapt.exe', 'aapt2.exe', 'apksigner.bat', 'd8.bat', 'zipalign.exe'

$platform = $null
$buildTools = $null
foreach ($sdkCandidate in $sdkCandidates) {
    if (-not $sdkCandidate -or -not (Test-Path -LiteralPath $sdkCandidate -PathType Container)) {
        continue
    }
    $sdkPath = (Resolve-Path -LiteralPath $sdkCandidate).Path
    $platform = Get-ChildItem -LiteralPath (Join-Path $sdkPath 'platforms') -Directory -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.Name -match '^android-(\d+)(?:\.(\d+))?$' -and [int]$Matches[1] -ge 34) {
                $androidJar = Join-Path $_.FullName 'android.jar'
                if (Test-Path -LiteralPath $androidJar -PathType Leaf) {
                    [pscustomobject]@{
                        Jar = $androidJar
                        Version = [version]::new([int]$Matches[1], [int]$Matches[2])
                    }
                }
            }
        } | Sort-Object Version -Descending | Select-Object -First 1
    $buildTools = Get-ChildItem -LiteralPath (Join-Path $sdkPath 'build-tools') -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' -and [version]$_.Name -ge [version]'34.0.0' } |
        Sort-Object { [version]$_.Name } -Descending |
        Where-Object {
            $toolDirectory = $_.FullName
            -not ($requiredTools | Where-Object {
                -not (Test-Path -LiteralPath (Join-Path $toolDirectory $_) -PathType Leaf)
            })
        } | Select-Object -First 1
    if ($platform -and $buildTools) {
        break
    }
}
if (-not $platform -or -not $buildTools) {
    throw 'Android SDK Platform 34 or newer and Build-Tools 34.0.0 or newer are required. Set ANDROID_HOME or pass -SdkRoot.'
}
$tools = $buildTools.FullName

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$outputRoot = (Resolve-Path -LiteralPath $OutputDirectory).Path
$buildDirectory = Join-Path $outputRoot ('.build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $buildDirectory | Out-Null
$savedJavaHome = $env:JAVA_HOME
$env:JAVA_HOME = $JavaHome

try {
    $classes = Join-Path $buildDirectory 'classes'
    $dex = Join-Path $buildDirectory 'dex'
    New-Item -ItemType Directory -Path $classes,$dex | Out-Null
    $resourceArchive = Join-Path $buildDirectory 'resources.zip'
    $unsignedApk = Join-Path $buildDirectory 'unsigned.apk'
    $alignedApk = Join-Path $buildDirectory 'aligned.apk'
    $signedApk = Join-Path $buildDirectory 'SmartCart-preview.apk'

    Invoke-AndroidTool (Join-Path $JavaHome 'bin\javac.exe') @(
        '--release', '11', '-encoding', 'UTF-8', '-classpath', $platform.Jar,
        '-d', $classes, (Join-Path $PSScriptRoot 'MainActivity.java')
    )
    $classFiles = @(Get-ChildItem -LiteralPath $classes -Recurse -Filter '*.class' | ForEach-Object FullName)
    Invoke-AndroidTool (Join-Path $tools 'd8.bat') (@(
        '--lib', $platform.Jar, '--min-api', '23', '--output', $dex
    ) + $classFiles)
    Invoke-AndroidTool (Join-Path $tools 'aapt2.exe') @(
        'compile', '--dir', (Join-Path $PSScriptRoot 'res'), '-o', $resourceArchive
    )
    Invoke-AndroidTool (Join-Path $tools 'aapt2.exe') @(
        'link', '-o', $unsignedApk, '-I', $platform.Jar, '--manifest',
        (Join-Path $PSScriptRoot 'AndroidManifest.xml'), $resourceArchive
    )
    Push-Location -LiteralPath $dex
    try {
        Invoke-AndroidTool (Join-Path $tools 'aapt.exe') @('add', '-f', $unsignedApk, 'classes.dex')
    } finally {
        Pop-Location
    }
    Invoke-AndroidTool (Join-Path $tools 'zipalign.exe') @('-f', '4', $unsignedApk, $alignedApk)

    if (-not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) {
        $keystoreDirectory = Split-Path -Parent $KeystorePath
        New-Item -ItemType Directory -Force -Path $keystoreDirectory | Out-Null
        $temporaryKeystore = Join-Path $keystoreDirectory ('.key-' + [guid]::NewGuid().ToString('N'))
        try {
            Invoke-AndroidTool (Join-Path $JavaHome 'bin\keytool.exe') @(
                '-genkeypair', '-keystore', $temporaryKeystore, '-storepass', 'android',
                '-keypass', 'android', '-alias', 'androiddebugkey', '-keyalg', 'RSA',
                '-keysize', '2048', '-validity', '3650', '-dname', 'CN=Android Debug,O=Android,C=US'
            )
            try {
                [IO.File]::Move($temporaryKeystore, $KeystorePath)
            } catch [IO.IOException] {
                if (-not (Test-Path -LiteralPath $KeystorePath -PathType Leaf)) {
                    throw
                }
            }
        } finally {
            if (Test-Path -LiteralPath $temporaryKeystore -PathType Leaf) {
                Remove-Item -LiteralPath $temporaryKeystore -Force
            }
        }
    }
    Invoke-AndroidTool (Join-Path $tools 'apksigner.bat') @(
        'sign', '--ks', $KeystorePath, '--ks-pass', 'pass:android', '--key-pass', 'pass:android',
        '--ks-key-alias', 'androiddebugkey', '--out', $signedApk, $alignedApk
    )
    Invoke-AndroidTool (Join-Path $tools 'apksigner.bat') @('verify', $signedApk)

    $apk = Join-Path $outputRoot 'SmartCart-preview.apk'
    try {
        [IO.File]::Move($signedApk, $apk)
    } catch [IO.IOException] {
        if (-not (Test-Path -LiteralPath $apk -PathType Leaf)) {
            throw
        }
        [IO.File]::Replace($signedApk, $apk, [NullString]::Value)
    }
    Write-Output $apk
} finally {
    $env:JAVA_HOME = $savedJavaHome
    $resolvedBuildDirectory = (Resolve-Path -LiteralPath $buildDirectory).Path
    if ([IO.Path]::GetDirectoryName($resolvedBuildDirectory) -eq $outputRoot) {
        Remove-Item -LiteralPath $resolvedBuildDirectory -Recurse -Force
    }
}
