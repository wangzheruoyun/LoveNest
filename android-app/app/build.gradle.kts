plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.github.wangzheruoyun.lovenest"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.github.wangzheruoyun.lovenest"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // The only dependency in this module. Path mapping / base64 unit tests are
    // pure JVM code, so plain JUnit 4 keeps the app itself dependency-free.
    testImplementation("junit:junit:4.13.2")
}

// Print every unit test's outcome. CI is the only place these can run (there is
// no JDK/Android SDK on the development machine), so the job log should show the
// tests executing, not just a bare "BUILD SUCCESSFUL".
tasks.withType<Test>().configureEach {
    testLogging {
        events("passed", "failed", "skipped")
    }
}
