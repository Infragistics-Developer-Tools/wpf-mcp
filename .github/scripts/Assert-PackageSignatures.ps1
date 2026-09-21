<#
.SYNOPSIS
    Verifies the Authenticode signature of Infragistics' own assembly inside a packed NuGet package.

.DESCRIPTION
    Packing does not sign or rebuild; --no-build just re-zips whatever bin/ output is on disk. The
    sign-assemblies job validates that loose output directly, but that is not proof the packed nupkg
    contains those exact bytes. This extracts the package that will actually ship and re-runs the
    Authenticode check against those bytes, so a pack step that picked up a stale or substituted DLL
    is still caught.

    Scoped to a single named assembly rather than every DLL in the package: this is a dotnet tool, so
    the output directory also carries third-party dependency assemblies (ModelContextProtocol,
    Microsoft.Extensions.*, ...) that are never signed with the Infragistics certificate and are not
    ours to sign.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PackagePath,

    [Parameter(Mandatory)]
    [string]$AssemblyPath,

    [Parameter(Mandatory)]
    [string]$ExpectedCertificateSha256Path,

    [string]$WorkingDirectory = (Join-Path ([System.IO.Path]::GetTempPath()) 'package-signature-validation')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
    throw "NuGet package not found: $PackagePath"
}

$extractPath = Join-Path $WorkingDirectory 'package'
# Expand-Archive only accepts .zip, so the package is copied under a name it will open.
$archivePath = Join-Path $WorkingDirectory 'package.zip'

try {
    New-Item -ItemType Directory -Path $WorkingDirectory -Force | Out-Null
    Copy-Item -LiteralPath $PackagePath -Destination $archivePath -Force
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractPath -Force

    $assemblyFullPath = Join-Path $extractPath $AssemblyPath
    if (-not (Test-Path -LiteralPath $assemblyFullPath -PathType Leaf)) {
        throw "Expected assembly not found in package: $AssemblyPath"
    }

    & (Join-Path $PSScriptRoot 'Assert-AuthenticodeSignature.ps1') -Path $assemblyFullPath -ExpectedCertificateSha256Path $ExpectedCertificateSha256Path
}
finally {
    Remove-Item -LiteralPath $WorkingDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
