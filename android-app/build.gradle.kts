// Root build script. Plugins are declared here (and applied in :app) so the
// whole build shares one pinned AGP + Kotlin version pair.
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
