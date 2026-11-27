pluginManagement {
    if (System.getenv("WILDSTRING_GRADLE_REFRESH_DEPENDENCIES") == "true") {
        gradle.startParameter.isRefreshDependencies = true
    }
    if (System.getenv("WILDSTRING_GRADLE_STACKTRACE") == "true") {
        gradle.startParameter.showStacktrace = org.gradle.api.logging.configuration.ShowStacktrace.ALWAYS
    }
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
    repositories { google(); mavenCentral() }
}
rootProject.name = "WildString"
include(":app")
