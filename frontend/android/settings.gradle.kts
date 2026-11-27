pluginManagement {
    if (System.getenv("WILDSTRING_GRADLE_REFRESH_DEPENDENCIES") == "true") {
        gradle.startParameter.isRefreshDependencies = true
    }
    if (System.getenv("WILDSTRING_GRADLE_STACKTRACE") == "true") {
        gradle.startParameter.showStacktrace = org.gradle.api.logging.configuration.ShowStacktrace.ALWAYS
    }
    val useCentralMirror =
        System.getenv("CI") == "true" ||
            System.getenv("WILDSTRING_GRADLE_CENTRAL_MIRROR") == "true"
    repositories {
        val centralPluginMarkers = listOf(
            "com.google.dagger.hilt.android" to "com.google.dagger.hilt.android.gradle.plugin",
            "com.google.devtools.ksp" to "com.google.devtools.ksp.gradle.plugin",
            "org.jetbrains.kotlin.android" to "org.jetbrains.kotlin.android.gradle.plugin",
            "org.jetbrains.kotlin.plugin.compose" to "org.jetbrains.kotlin.plugin.compose.gradle.plugin",
        )
        google {
            content {
                centralPluginMarkers.forEach { (group, module) -> excludeModule(group, module) }
            }
        }
        if (useCentralMirror) {
            // Avoid GitHub Actions shared-IP HTTP 429 limits on repo.maven.apache.org;
            // every artifact hash is still strictly checked by verification-metadata.xml.
            maven {
                name = "GoogleMavenCentralMirror"
                url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
                content {
                    excludeModule("com.android.application", "com.android.application.gradle.plugin")
                }
            }
        }
        mavenCentral {
            content {
                excludeModule("com.android.application", "com.android.application.gradle.plugin")
            }
        }
        gradlePluginPortal {
            content {
                // Keep authoritative markers on Google Maven / Maven Central so the Portal proxy is skipped.
                excludeModule("com.android.application", "com.android.application.gradle.plugin")
                centralPluginMarkers.forEach { (group, module) -> excludeModule(group, module) }
            }
        }
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    val useCentralMirror =
        System.getenv("CI") == "true" ||
            System.getenv("WILDSTRING_GRADLE_CENTRAL_MIRROR") == "true"
    repositories {
        google()
        if (useCentralMirror) {
            maven {
                name = "GoogleMavenCentralMirror"
                url = uri("https://maven-central.storage-download.googleapis.com/maven2/")
            }
        }
        mavenCentral()
    }
}
rootProject.name = "WildString"
include(":app")
