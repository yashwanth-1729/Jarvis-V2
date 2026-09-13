<#
.SYNOPSIS
  Fetch the Telugu Piper voice for the Android on-device bridge.

.DESCRIPTION
  Adds a second on-device voice (te_IN-padmavathi-medium) alongside the
  existing English one set up by setup_piper.ps1 -- run that script first;
  this one reuses its sherpa-onnx AAR and shared espeak-ng-data rather than
  fetching either again.

  Unlike English, there is no ready-made sherpa-onnx tarball for this voice
  (k2-fsa's "tts-models" release only publishes a handful of English/Chinese
  bundles). Piper's own voice files are enough on their own, so this script:

    1. fetches the raw voice pair (model.onnx + model.onnx.json) from
       rhasspy/piper-voices on HuggingFace -- the same source
       `piper.download_voices` used for the desktop copy at
       backend/models/piper/te_IN-padmavathi-medium.onnx, reused directly if
       already present there instead of downloading it twice.
    2. derives tokens.txt from the onnx.json's `phoneme_id_map` -- sherpa-onnx
       wants "symbol id" per line, sorted by id; that is exactly what Piper's
       map already contains, just reshaped. Verified against the existing
       English tokens.txt: same derivation, same format.
    3. places both under assets/piper/, named distinctly
       (te_IN-padmavathi-medium.onnx / .tokens.txt) since a second voice can
       no longer use the generic "tokens.txt" name English claimed first.

  espeak-ng-data is not re-fetched: it is Piper's shared, language-independent
  phonemizer data (the same directory covers every espeak-supported language,
  Telugu's `te` included), so English's copy already covers this voice too.

.PARAMETER Force
  Re-download and overwrite even if the files already exist.

.EXAMPLE
  ./backend/tools/android/setup_piper.ps1          # English voice + AAR + espeak data, first
  ./backend/tools/android/setup_piper_telugu.ps1   # then this, for Telugu
#>
param([switch]$Force)

$ErrorActionPreference = "Stop"

$VOICE_NAME  = "te_IN-padmavathi-medium"
$VOICE_URL_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main/te/te_IN/padmavathi/medium"

# Repo layout: this script sits at backend/tools/android/, so the repo root is
# three directories up.
$repoRoot    = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$androidApp  = Join-Path $repoRoot "frontend/src-tauri/gen/android/app"
$assetsDir   = Join-Path $androidApp "src/main/assets/piper"
$desktopOnnx = Join-Path $repoRoot "backend/models/piper/$VOICE_NAME.onnx"
$desktopJson = Join-Path $repoRoot "backend/models/piper/$VOICE_NAME.onnx.json"

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
  & curl.exe -L --fail --retry 3 -o $dest $url
  if ($LASTEXITCODE -ne 0) { throw "download failed ($LASTEXITCODE): $url" }
  $size = (Get-Item $dest).Length
  if ($size -lt $minBytes) { throw "downloaded file is too small ($size bytes); expected >= $minBytes" }
  Write-Ok "saved $([math]::Round($size/1MB,1)) MB -> $dest"
}

Write-Host ""
Write-Host "JARVIS - Android Piper setup (Telugu)" -ForegroundColor White
Write-Host "repo: $repoRoot"
Write-Host ""

# ---------------------------------------------------------------------------
# 0. Preconditions -- English setup must have run first (shared AAR + espeak data)
# ---------------------------------------------------------------------------
$espeakData = Join-Path $assetsDir "espeak-ng-data"
if (-not (Test-Path $espeakData)) {
  throw "espeak-ng-data missing at $espeakData -- run setup_piper.ps1 first (it fetches the shared sherpa-onnx AAR and espeak data that this script reuses)."
}
Write-Ok "shared espeak-ng-data found (reused, not re-fetched)"

# ---------------------------------------------------------------------------
# 1. The voice model -- reuse the desktop copy if present, else fetch it
# ---------------------------------------------------------------------------
Write-Step "$VOICE_NAME voice files"
$onnxDest = Join-Path $assetsDir "$VOICE_NAME.onnx"
$jsonTmp  = Join-Path $env:TEMP "jarvis-piper-telugu-setup\$VOICE_NAME.onnx.json"

if ((Test-Path $onnxDest) -and -not $Force) {
  Write-Ok "voice already placed: $onnxDest"
} elseif ((Test-Path $desktopOnnx) -and (Test-Path $desktopJson) -and -not $Force) {
  Write-Ok "reusing desktop copy (already downloaded for backend TTS): $desktopOnnx"
  New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
  Copy-Item -Force $desktopOnnx $onnxDest
} else {
  Get-File "$VOICE_URL_BASE/$VOICE_NAME.onnx" $onnxDest (10 * 1MB)
}

# The .onnx.json is only needed transiently, to derive tokens.txt -- it is not
# itself one of sherpa-onnx's expected asset files.
$jsonSource = $null
if (Test-Path $desktopJson) {
  $jsonSource = $desktopJson
} else {
  Get-File "$VOICE_URL_BASE/$VOICE_NAME.onnx.json" $jsonTmp 500
  $jsonSource = $jsonTmp
}

# ---------------------------------------------------------------------------
# 2. tokens.txt -- derived from the voice config, not downloaded
# ---------------------------------------------------------------------------
$tokensDest = Join-Path $assetsDir "$VOICE_NAME.tokens.txt"
if ((Test-Path $tokensDest) -and -not $Force) {
  Write-Ok "tokens already derived: $tokensDest"
} else {
  Write-Step "deriving tokens.txt from $jsonSource"
  # PowerShell's ConvertFrom-Json folds property names case-insensitively
  # (a PSObject thing, not a JSON thing) and this phoneme map has both 'X'
  # and 'x' as distinct symbols -- it throws DuplicateKeysInJsonString.
  # Python's json module has no such issue, and every dev machine here
  # already has the backend venv, so do the derivation there instead.
  $py = Join-Path $repoRoot "backend/.venv/Scripts/python.exe"
  if (-not (Test-Path $py)) { $py = "python" }
  $script = @'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    config = json.load(f)
items = sorted(config["phoneme_id_map"].items(), key=lambda kv: kv[1][0])
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as f:
    for symbol, ids in items:
        f.write(f"{symbol} {ids[0]}\n")
print(len(items))
'@
  $scriptPath = Join-Path $env:TEMP "jarvis-piper-telugu-setup\derive_tokens.py"
  New-Item -ItemType Directory -Force -Path (Split-Path $scriptPath) | Out-Null
  New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null
  Set-Content -Path $scriptPath -Value $script -Encoding UTF8
  $count = & $py $scriptPath $jsonSource $tokensDest
  if ($LASTEXITCODE -ne 0) { throw "tokens.txt derivation failed ($LASTEXITCODE)" }
  Write-Ok "wrote $count symbols -> $tokensDest"
}

Remove-Item -Recurse -Force (Split-Path $jsonTmp) -ErrorAction SilentlyContinue

# ---------------------------------------------------------------------------
# 3. Verify
# ---------------------------------------------------------------------------
Write-Step "verifying"
$need = @($onnxDest, $tokensDest, $espeakData)
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
    Write-Ok "ok  $p ($([math]::Round((Get-Item $p).Length/1MB,2)) MB)"
  }
}

Write-Host ""
Write-Host "Telugu Piper assets are in place." -ForegroundColor Green
Write-Host "Next (see docs/android-piper-tts.md):" -ForegroundColor White
Write-Host "  1. JarvisTts.kt already registers this voice by id (`"$VOICE_NAME`")."
Write-Host "  2. Build + install:  cd frontend; npm run android:install"
Write-Host ""
