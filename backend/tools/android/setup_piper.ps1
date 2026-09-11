<#
.SYNOPSIS
  Fetch everything the Android build needs to speak English with Piper on-device.

.DESCRIPTION
  Mobile English TTS runs the same high-tier voice as desktop (en_US-ryan-high)
  through sherpa-onnx's prebuilt arm64 library. Two large binaries make that
  work, and neither belongs in git:

    1. the sherpa-onnx Android AAR  -> app/libs/
    2. the ryan-high voice bundle   -> app/src/main/assets/piper/
       (model.onnx + tokens.txt + espeak-ng-data/, all in one download)

  This script downloads and places both, idempotently, so the Android build is
  a plain `npm run android:install` afterwards. It changes no source code — the
  Gradle line and the Kotlin bridge are applied per docs/android-piper-tts.md.

  Run it once on the build machine (needs internet + `curl` + `tar`, both built
  into Windows 10+). Re-running is safe; it skips what is already in place.

.PARAMETER Force
  Re-download and overwrite even if the files already exist.

.EXAMPLE
  ./backend/tools/android/setup_piper.ps1
#>
param([switch]$Force)

$ErrorActionPreference = "Stop"

# Pinned versions. Bump SHERPA_VERSION when moving to a newer AAR; the model
# bundle lives in the rolling 'tts-models' release and is not versioned.
$SHERPA_VERSION = "1.13.8"
$AAR_NAME       = "sherpa-onnx-$SHERPA_VERSION.aar"
$AAR_URL        = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$SHERPA_VERSION/$AAR_NAME"
$MODEL_NAME     = "vits-piper-en_US-ryan-high"
$MODEL_URL      = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/$MODEL_NAME.tar.bz2"

# Repo layout: this script sits at backend/tools/android/, so the repo root is
# three directories up.
$repoRoot   = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$androidApp = Join-Path $repoRoot "frontend/src-tauri/gen/android/app"
$libsDir    = Join-Path $androidApp "libs"
$assetsDir  = Join-Path $androidApp "src/main/assets/piper"
$tmpDir     = Join-Path $env:TEMP "jarvis-piper-setup"

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }

function Get-File($url, $dest, $minBytes) {
  if ((Test-Path $dest) -and -not $Force) {
    $size = (Get-Item $dest).Length
    if ($size -ge $minBytes) { Write-Ok "already present ($([math]::Round($size/1MB,1)) MB): $dest"; return }
    Write-Ok "re-fetching (existing file looks truncated): $dest"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  Write-Step "downloading $url"
  # curl.exe (not the PowerShell alias) streams to disk with a progress bar and
  # handles the large model file without buffering it all in memory.
  & curl.exe -L --fail --retry 3 -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
  $size = (Get-Item $dest).Length
  if ($size -lt $minBytes) { throw "downloaded file is too small ($size bytes); expected >= $minBytes" }
  Write-Ok "saved $([math]::Round($size/1MB,1)) MB -> $dest"
}

Write-Host ""
Write-Host "JARVIS - Android Piper setup" -ForegroundColor White
Write-Host "repo: $repoRoot"
Write-Host ""

# ---------------------------------------------------------------------------
# 1. The native library
# ---------------------------------------------------------------------------
Write-Step "sherpa-onnx AAR (arm64 native TTS engine)"
$aarDest = Join-Path $libsDir $AAR_NAME
Get-File $AAR_URL $aarDest (5 * 1MB)

# ---------------------------------------------------------------------------
# 2. The voice model (bundled into APK assets, copied to filesDir on first run)
# ---------------------------------------------------------------------------
Write-Step "$MODEL_NAME voice bundle"
$onnx = Join-Path $assetsDir "en_US-ryan-high.onnx"
if ((Test-Path $onnx) -and -not $Force) {
  Write-Ok "voice already extracted: $assetsDir"
} else {
  New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
  $tar = Join-Path $tmpDir "$MODEL_NAME.tar.bz2"
  Get-File $MODEL_URL $tar (20 * 1MB)

  Write-Step "extracting voice bundle"
  $extractRoot = Join-Path $tmpDir "extract"
  Remove-Item -Recurse -Force $extractRoot -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  # tar on Windows 10+ (bsdtar) reads .tar.bz2 directly.
  & tar -xf $tar -C $extractRoot
  if ($LASTEXITCODE -ne 0) { throw "extraction failed ($LASTEXITCODE)" }

  # The archive extracts into a top folder named after the model; flatten it
  # into assets/piper/ so the Kotlin side finds fixed paths.
  $inner = Join-Path $extractRoot $MODEL_NAME
  if (-not (Test-Path $inner)) { $inner = $extractRoot }
  New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
  Copy-Item -Recurse -Force (Join-Path $inner "*") $assetsDir
  Write-Ok "voice placed -> $assetsDir"
  Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
# 3. Verify
# ---------------------------------------------------------------------------
Write-Step "verifying"
$need = @(
  $aarDest,
  (Join-Path $assetsDir "en_US-ryan-high.onnx"),
  (Join-Path $assetsDir "tokens.txt"),
  (Join-Path $assetsDir "espeak-ng-data")
)
$missing = $need | Where-Object { -not (Test-Path $_) }
if ($missing) {
  Write-Host "MISSING:" -ForegroundColor Red
  $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  throw "setup incomplete"
}
foreach ($p in $need) {
  if (Test-Path $p -PathType Container) {
    $n = (Get-ChildItem -Recurse $p | Measure-Object).Count
    Write-Ok "ok  $p ($n files)"
  } else {
    Write-Ok "ok  $p ($([math]::Round((Get-Item $p).Length/1MB,1)) MB)"
  }
}

Write-Host ""
Write-Host "Piper assets are in place." -ForegroundColor Green
Write-Host "Next (see docs/android-piper-tts.md):" -ForegroundColor White
Write-Host "  1. Add the Gradle dependency:  implementation(files(`"libs/$AAR_NAME`"))"
Write-Host "  2. Add JarvisTts.kt and register the bridge in MainActivity."
Write-Host "  3. Apply the realtime.ts/backend wiring for English-on-Android."
Write-Host "  4. Build + install:  cd frontend; npm run android:install"
Write-Host ""
