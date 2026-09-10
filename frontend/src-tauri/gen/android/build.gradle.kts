buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
        // Embeds a CPython runtime in the APK so the phone can host its own
        // JARVIS backend rather than depending on a machine on the LAN.
        // 17.0.0 supports Python 3.13 and AGP 7.3-9.2, which brackets the
        // 8.11.0 above.
        classpath("com.chaquo.python:gradle:17.0.0")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}

