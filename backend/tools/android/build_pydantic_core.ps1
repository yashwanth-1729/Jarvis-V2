# Cross-compile pydantic-core for Android (arm64-v8a).
#
# pydantic-core is the only dependency of the JARVIS backend with native code
# that cannot be avoided -- everything else is pure Python or has a pure-Python
# fallback. Nobody publishes an Android build of it: pydantic/pydantic#12739 is
# open and deferred, and Chaquopy's index does not carry it. The third-party
# Termux wheels that do exist hardcode an RPATH of
# /data/data/com.termux/files/usr/lib, which does not exist inside our app, so
# they cannot be used either.
#
# Hence this. The result links against Chaquopy's own libpython3.13.so and
# carries no RPATH at all, so Android's loader resolves the interpreter from the
# app's jniLibs -- which is exactly where Chaquopy puts it.
#
# Prerequisites (already installed on this machine):
#   * Rust with the aarch64-linux-android target
#   * Android NDK 27.2.12479018
#   * Chaquopy's Android Python runtime, downloaded below
#
# Usage:  powershell -File build_pydantic_core.ps1

$ErrorActionPreference = "Stop"

$PydanticCoreVersion = "2.46.4"   # must match the installed `pydantic` version
$PythonVersion       = "3.13"     # must match Chaquopy's Python
$ChaquopyTarget      = "3.13.9-0"
$NdkRoot             = "D:\Android\Sdk\ndk\27.2.12479018"
$ApiLevel            = 24         # Chaquopy 17's minimum

$work   = Join-Path $env:TEMP "jarvis-pydantic-core-android"
$ndkBin = "$NdkRoot\toolchains\llvm\prebuilt\windows-x86_64\bin"
New-Item -ItemType Directory -Force -Path $work | Out-Null

# --- source ---------------------------------------------------------------
Push-Location $work
if (-not (Test-Path "pydantic_core-$PydanticCoreVersion")) {
    $meta = Invoke-RestMethod "https://pypi.org/pypi/pydantic-core/$PydanticCoreVersion/json"
    $sdist = ($meta.urls | Where-Object { $_.packagetype -eq "sdist" }).url
    Invoke-WebRequest $sdist -OutFile "pc.tar.gz"
    tar xzf pc.tar.gz
    Remove-Item pc.tar.gz
}

# --- Chaquopy's Android libpython -----------------------------------------
# Linking against the interpreter that will actually host the module is what
# makes this loadable on-device; a mismatched libpython fails at import time,
# not at link time, so it is worth being exact here.
if (-not (Test-Path "chaquo\arm64\jniLibs\arm64-v8a\libpython$PythonVersion.so")) {
    $url = "https://repo.maven.apache.org/maven2/com/chaquo/python/target/$ChaquopyTarget/target-$ChaquopyTarget-arm64-v8a.zip"
    New-Item -ItemType Directory -Force -Path "chaquo" | Out-Null
    Invoke-WebRequest $url -OutFile "chaquo\arm64.zip"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory("$work\chaquo\arm64.zip", "$work\chaquo\arm64")
}
$chaquoLibs = "$work\chaquo\arm64\jniLibs\arm64-v8a"

# --- build ----------------------------------------------------------------
Set-Location "$work\pydantic_core-$PydanticCoreVersion"

$env:PATH = "$env:USERPROFILE\.cargo\bin;$ndkBin;" + $env:PATH
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$ndkBin\aarch64-linux-android$ApiLevel-clang.cmd"
$env:AR_aarch64_linux_android = "$ndkBin\llvm-ar.exe"
$env:CC_aarch64_linux_android = "$ndkBin\aarch64-linux-android$ApiLevel-clang.cmd"

# PyO3 cross-compilation. maturin cannot do this job: its bundled sysconfig
# database has no Android CPython entry, so it fails before reaching the
# compiler. Driving cargo directly sidesteps that, and the wheel is assembled
# separately afterwards.
$env:PYO3_CROSS = "1"
$env:PYO3_CROSS_PYTHON_VERSION = $PythonVersion
$env:PYDANTIC_CORE_VERSION = $PydanticCoreVersion
$env:RUSTFLAGS = "-L native=$chaquoLibs"

cargo build --release --target aarch64-linux-android --features pyo3/extension-module
if ($LASTEXITCODE -ne 0) { throw "cargo build failed" }

# --- collect --------------------------------------------------------------
$built = "target\aarch64-linux-android\release\lib_pydantic_core.so"
$out   = Join-Path $PSScriptRoot "prebuilt"
New-Item -ItemType Directory -Force -Path $out | Out-Null
# Renamed to the import name Python expects; the `lib` prefix is a cargo
# convention, not something CPython looks for.
Copy-Item $built (Join-Path $out "_pydantic_core.cpython-313-aarch64-linux-android.so") -Force

Pop-Location
Write-Output "built: $out\_pydantic_core.cpython-313-aarch64-linux-android.so"
