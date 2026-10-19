plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is driven entirely by environment variables, because the real
// keystore must never enter the repo. The CI release job (.github/workflows/build.yml)
// decodes the KEYSTORE_BASE64 secret back into a file and sets:
//   KEYSTORE_FILE      absolute path to the decoded PKCS#12 keystore
//   KEYSTORE_PASSWORD  store password (the same value is used for the key)
//   KEY_ALIAS          key alias
//   KEY_PASSWORD       key password
// On an ordinary branch push none of these exist, and that must still build: so
// both the signing config and the release signingConfig assignment are guarded by
// "is a keystore actually present?". No keystore -> configure fine, and the debug
// build is untouched.
val releaseKeystorePath = System.getenv("KEYSTORE_FILE")
val hasReleaseKeystore = releaseKeystorePath != null && file(releaseKeystorePath).exists()

android {
    namespace = "com.github.wangzheruoyun.lovenest"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.github.wangzheruoyun.lovenest"
        minSdk = 26
        targetSdk = 34
        versionCode = 5
        versionName = "1.0.0-fix3"
    }

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                keyAlias = System.getenv("KEY_ALIAS")
                keyPassword = System.getenv("KEY_PASSWORD")
                // The keystore was produced by openssl (this machine has no
                // keytool), so it is a PKCS#12 container, not a JKS.
                storeType = "PKCS12"
            }
        }
    }

    buildTypes {
        release {
            // R8/minification stays OFF on purpose: the @JavascriptInterface
            // methods GameBridge exports are exactly what a shrinker strips, and
            // there is no device on which a stripped APK could be tested here.
            isMinifyEnabled = false
            // Only sign when a keystore was supplied. A machine/CI run without the
            // secrets still configures and builds (producing an unsigned release
            // APK, which the release job refuses to publish).
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
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
    // androidx.core provides FileProvider, which is the only correct way to hand a
    // user file to another app on API 24+ (GameBridge.openFile, i.e. nw.Shell.openItem).
    // JUnit stays the only test dependency: path/base64 tests are pure JVM code.
    implementation("androidx.core:core:1.13.1")
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
