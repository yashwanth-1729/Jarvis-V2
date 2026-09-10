import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
    id("com.chaquo.python")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "builds.yashwanth.jarvis"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "builds.yashwanth.jarvis"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")

        ndk {
            abiFilters += listOf("arm64-v8a")
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}


// Stage the JARVIS backend into Chaquopy's Python source set.
//
// Copied rather than referenced because Chaquopy takes whole directories, and
// `backend/` also holds .venv, storage and tests -- hundreds of megabytes that
// must not reach the APK. Copying keeps backend/ the single source of truth
// while shipping only what the phone actually runs.
val stageJarvisBackend by tasks.registering(Copy::class) {
    description = "Copy the JARVIS Python backend into the Android Python sources."
    from("../../../../../backend") {
        include("app/**", "main.py")
        exclude("**/__pycache__/**", "**/*.pyc")
    }
    into("src/main/python")
}

// Chaquopy's source-merge task reads the directory this one writes, and Gradle
// requires the *consuming* task to say so -- ordering via preBuild alone fails
// validation, because Gradle cannot prove the two are related.
tasks.matching { it.name.contains("PythonSources") }.configureEach {
    dependsOn(stageJarvisBackend)
}
tasks.named("preBuild") { dependsOn(stageJarvisBackend) }

chaquopy {
    // Configured per-flavor rather than in defaultConfig on purpose.
    //
    // Tauri's rust plugin always creates flavors for all four ABIs, and
    // Chaquopy validates every variant at configuration time. Python 3.13 only
    // ships for arm64-v8a and x86_64, so a global config makes the armeabi-v7a
    // and x86 variants fail the build even though we never assemble them.
    // Scoping it to the flavors we actually build leaves the others without a
    // Python runtime, which is exactly right.
    productFlavors {
        getByName("arm64") {
            // Must match the interpreter the pydantic-core wheel was linked
            // against; a mismatch fails at import time, not at build time.
            version = "3.13"

            pip {
                // pydantic-core has no Android build anywhere upstream, so this
                // is ours, cross-compiled against Chaquopy's own libpython.
                // See backend/tools/android/build_pydantic_core.ps1.
                install("../../../../../backend/tools/android/prebuilt/pydantic_core-2.46.4-0-cp313-cp313-android_24_arm64_v8a.whl")
                install("pydantic==2.13.4")

                // The backend itself. Deliberately plain `uvicorn` rather than
                // uvicorn[standard]: the extras (uvloop, httptools, watchfiles)
                // are all native, none is imported by our code, and uvicorn
                // falls back to pure-Python equivalents without them.
                install("fastapi==0.141.1")
                install("uvicorn==0.52.3")
                install("wsproto==1.2.0")        // pure-Python websockets for voice
                install("aiosqlite==0.22.1")
                install("pydantic-settings==2.15.0")
                install("python-dotenv==1.2.2")
                install("python-multipart==0.0.32")
                install("httpx==0.28.1")
            }
        }
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")