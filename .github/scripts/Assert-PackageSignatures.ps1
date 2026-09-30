<#
.SYNOPSIS
    Verifies the Authenticode signature of Infragistics' own assembly inside a packed NuGet package.

.DESCRIPTION
    The sign tool signs the assembly in place inside the nupkg, as selected by eng/sign-filelist.txt,
    and then signs the package itself. A valid package signature says nothing about whether the inner
    assembly was actually signed (a file list that matched nothing still yields a signed package), so
    this extracts the package that will actually ship and runs the Authenticode check against those
    exact bytes.

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
