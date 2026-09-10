/**
 * Build (and optionally install) the Android APK.
 *
 * `tauri android build` cannot complete on Windows: after cross-compiling the
 * Rust library it tries to *symlink* it into Gradle's jniLibs, and Windows
 * refuses symlink creation without Developer Mode. Tauri's own advice is to
 * enable that; this script copies the file instead, so nothing about the
 * machine's security settings has to change.
 *
 * Gradle then needs `-x rustBuildArm64Debug`, because that task would redo the
 * cross-compile *and* the symlink, failing the same way. The library is already
 * built and in place by then.
 *
 * Doing this by hand is four steps in a specific order, and skipping one
 * silently ships a stale library with fresh web assets -- a mismatch that looks
 * like a UI bug and isn't. Hence a script.
 *
 *   node scripts/build-android.mjs            # build
 *   node scripts/build-android.mjs --install  # build, then install to a device
 *   node scripts/build-android.mjs --run      # build, install, launch, tail logs
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ANDROID = join(FRONTEND, "src-tauri", "gen", "android");
const ABI = "arm64-v8a";
const TARGET = "aarch64-linux-android";
const PACKAGE = "builds.yashwanth.jarvis.debug";

/** Newest mtime anywhere under `dir`, so "was this rebuilt?" can be answered. */
function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const at = entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs;
    if (at > newest) newest = at;
  }
  return newest;
}

const args = new Set(process.argv.slice(2));
const wantInstall = args.has("--install") || args.has("--run");
const wantRun = args.has("--run");

// ---------------------------------------------------------------------------

const bold = (s) => `\u001b[1m${s}\u001b[0m`;
const red = (s) => `\u001b[31m${s}\u001b[0m`;

function fail(message) {
  console.error(`\n${red("✗")} ${message}\n`);
  process.exit(1);
}

function step(n, total, label) {
  console.log(`\n${bold(`[${n}/${total}]`)} ${label}`);
}

/** First existing path from the candidates, or null. */
function firstExisting(candidates) {
  return candidates.find((c) => c && existsSync(c)) ?? null;
}

function detectEnvironment() {
  const androidHome = firstExisting([
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    "D:\\Android\\Sdk",
    join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk"),
    join(process.env.HOME ?? "", "Android", "Sdk"),
  ]);
  if (!androidHome) fail("Android SDK not found. Set ANDROID_HOME.");

  // Chaquopy and AGP both want a JDK; 25 is too new for the Android Gradle
  // plugin, so prefer an explicitly installed 21 over whatever is on PATH.
  const javaHome = firstExisting([
    process.env.JAVA_HOME_21,
    "C:\\Program Files\\Java\\jdk-21",
    process.env.JAVA_HOME,
  ]);
  if (!javaHome) fail("A JDK (21 recommended) not found. Set JAVA_HOME.");

  const ndkRoot = join(androidHome, "ndk");
  const ndk = existsSync(ndkRoot)
    ? join(ndkRoot, readdirSync(ndkRoot).sort().pop())
    : null;
  if (!ndk) fail(`No NDK under ${ndkRoot}. Install one via sdkmanager.`);

  return { androidHome, javaHome, ndk };
}

function run(command, cmdArgs, { cwd, env, allowFailure = false }) {
  const result = spawnSync(command, cmdArgs, {
    cwd,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0 && !allowFailure) {
    fail(`${command} ${cmdArgs.join(" ")} exited with ${result.status}`);
  }
  return result.status === 0;
}

// ---------------------------------------------------------------------------

const { androidHome, javaHome, ndk } = detectEnvironment();

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  NDK_HOME: ndk,
  // Some Windows shells leak GRADLE_USER_HOME as C:\\.gradle. Gradle then
  // tries to create wrapper locks at the drive root and packaging fails after
  // the expensive web/Rust stages have already completed.
  GRADLE_USER_HOME: join(process.env.USERPROFILE ?? process.env.HOME ?? FRONTEND, ".gradle"),
  PATH: [
    join(javaHome, "bin"),
    join(androidHome, "platform-tools"),
    process.env.PATH,
  ].join(process.platform === "win32" ? ";" : ":"),
};

const adb = join(androidHome, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const total = wantRun ? 5 : wantInstall ? 4 : 3;

console.log(`${bold("JARVIS Android build")}`);
console.log(`  sdk  ${androidHome}`);
console.log(`  ndk  ${ndk}`);
console.log(`  jdk  ${javaHome}`);

// -- 1. frontend + rust -----------------------------------------------------
// Expected to fail at the symlink step on Windows; the artefacts it produced
// before that point are what we want, so the failure is tolerated and then
// verified against rather than trusted.
step(1, total, "Building web assets and cross-compiling Rust");
run("npx", ["tauri", "android", "build", "--debug", "--target", "aarch64", "--apk"], {
  cwd: FRONTEND,
  env,
  allowFailure: true,
});

// -- 2. place the library ---------------------------------------------------
step(2, total, "Placing the Rust library (copy, not symlink)");
const builtSo = join(FRONTEND, "src-tauri", "target", TARGET, "debug", "libapp_lib.so");
if (!existsSync(builtSo)) {
  fail(`Rust library missing at ${builtSo}\nThe cross-compile failed for a real reason — scroll up.`);
}

const webAssets = join(FRONTEND, "out", "index.html");
if (existsSync(webAssets) && statSync(builtSo).mtimeMs < statSync(webAssets).mtimeMs) {
  // The web bundle is compiled *into* the Rust library, so a library older than
  // the export means the UI changes are not in this build. Silent staleness is
  // the exact failure this script exists to prevent.
  fail("The Rust library is older than the web assets — the cross-compile did not re-run.");
}

// ...and the same check in the other direction, which was missing.
//
// The test above only ever asked "is the library at least as new as the
// export?". It says nothing about whether the *export* was rebuilt from source,
// so a step 1 that died before `next build` ran left a four-hour-old `out/`
// paired with a newer library -- and every check passed. Four APKs shipped a
// stale UI that way, each reported as a success, because step 1 is
// `allowFailure` and the failure was a one-line PATH error scrolled off the top.
//
// The likely cause is running this script from a shell where `npx` cannot
// resolve node ("'\"node\"' is not recognized"). Build from PowerShell.
if (!existsSync(webAssets)) {
  fail("No web export at out/index.html — step 1 never produced one.");
}
const exportedAt = statSync(webAssets).mtimeMs;
const newestSource = newestMtime(join(FRONTEND, "src"));
if (newestSource > exportedAt) {
  const behind = Math.round((newestSource - exportedAt) / 60_000);
  fail(
    `The web export is ${behind} minute(s) older than src/ — step 1 did not rebuild it.\n` +
      "The APK would ship a stale UI. Scroll up for step 1's error; if it says\n" +
      `'"node" is not recognized', run this script from PowerShell rather than bash.`,
  );
}

const jniDir = join(ANDROID, "app", "src", "main", "jniLibs", ABI);
mkdirSync(jniDir, { recursive: true });
copyFileSync(builtSo, join(jniDir, "libapp_lib.so"));
console.log(`      ${(statSync(builtSo).size / 1048576).toFixed(1)} MB → jniLibs/${ABI}/`);

// -- 3. package -------------------------------------------------------------
step(3, total, "Packaging the APK (Chaquopy + Gradle)");
// Absolute path: Windows does not resolve `gradlew.bat` from the working
// directory the way a POSIX shell resolves `./gradlew`, so a bare name here
// fails with "not recognized" even though the file is right there.
const gradlew = join(ANDROID, process.platform === "win32" ? "gradlew.bat" : "gradlew");
run(gradlew, ["assembleArm64Debug", "-x", "rustBuildArm64Debug", "--console=plain"], {
  cwd: ANDROID,
  env,
});

const apk = join(ANDROID, "app", "build", "outputs", "apk", "arm64", "debug", "app-arm64-debug.apk");
if (!existsSync(apk)) fail("Gradle reported success but produced no APK.");
console.log(`\n${bold("APK")} ${apk}`);
console.log(`    ${(statSync(apk).size / 1048576).toFixed(1)} MB`);

// -- 4. install -------------------------------------------------------------
if (wantInstall) {
  step(4, total, "Installing to the connected device");
  const devices = spawnSync(adb, ["devices"], { encoding: "utf8" });
  if (!/\S+\s+device\s*$/m.test(devices.stdout ?? "")) {
    fail("No authorised device. Check the cable and the USB-debugging prompt.");
  }
  run(adb, ["install", "-r", apk], { env });
}

// -- 5. launch and tail -----------------------------------------------------
if (wantRun) {
  step(5, total, "Launching and tailing the backend log");
  run(adb, ["logcat", "-c"], { env, allowFailure: true });
  run(adb, ["shell", "monkey", "-p", PACKAGE, "-c", "android.intent.category.LAUNCHER", "1"], {
    env,
    allowFailure: true,
  });
  console.log("\n  Ctrl-C to stop tailing.\n");
  run(adb, ["logcat", "-s", "JarvisPython"], { env, allowFailure: true });
}

console.log(`\n${bold("Done.")}\n`);
